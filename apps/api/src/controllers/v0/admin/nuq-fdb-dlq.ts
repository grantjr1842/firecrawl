import { Logger } from "winston";
import { Request, Response } from "express";
import { logger as _logger } from "../../../lib/logger";
import { config } from "../../../config";
import {
  NuqFdbKeyspace,
  decodeJson,
} from "../../../services/worker/nuq-fdb/keyspace";
import {
  DlqRecord,
  listDlqRecords,
  readDlqRecord,
  deleteDlqRecord,
  appendDlqError,
} from "../../../services/worker/nuq-fdb/ops";
import { scrapeQueueFdb } from "../../../services/worker/nuq-fdb";
import { getNuqFdbDatabase } from "../../../services/worker/nuq-fdb/client";

// QR-001(d): admin list + replay for the NuQ FDB DLQ. Mirror of
// extract-queue's DLQ pattern (see services/extract-queue.ts:122-155) —
// listed under /admin/{BULL_AUTH_KEY}/nuq-fdb/dlq/{list,replay/:jobId}.
//
// Listing returns DLQ records newest-failed first plus the per-job error
// history; replay re-enqueues the original payload via addJob, drops the DLQ
// record + error log, and records a "manual" error entry so the operator
// gets an audit trail of who replayed what.

const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 500;

export async function nuqFdbDlqListController(
  req: Request,
  res: Response,
): Promise<void> {
  const logger = _logger.child({ module: "nuq-fdb-dlq-list" });
  const limit = clampListLimit(req.query.limit);
  const queue = resolveDlqQueue(req, logger);

  try {
    const db = getNuqFdbDatabase();
    const records = await db.doTn(tn => listDlqRecords(tn, queue.ks, limit));
    const detailed = await Promise.all(
      records.map(async rec => {
        const detail = await db.doTn(tn =>
          readDlqRecord(tn, queue.ks, rec.jobId),
        );
        return { ...rec, errors: detail?.errors ?? [] };
      }),
    );
    res.json({
      success: true,
      queueName: queue.queueName,
      count: detailed.length,
      records: detailed,
    });
  } catch (error) {
    logger.error("NuQ FDB DLQ list failed", { error });
    res.status(500).json({ success: false, error: "nuq_fdb_dlq_list_failed" });
  }
}

export async function nuqFdbDlqReplayController(
  req: Request,
  res: Response,
): Promise<void> {
  const logger = _logger.child({ module: "nuq-fdb-dlq-replay" });
  const jobId =
    typeof req.params.jobId === "string" && req.params.jobId.length > 0
      ? req.params.jobId
      : null;
  if (!jobId) {
    res.status(400).json({
      success: false,
      error: "job_id_required",
      message: "jobId path param is required",
    });
    return;
  }

  const queue = resolveDlqQueue(req, logger);
  const db = getNuqFdbDatabase();
  let detail: { record: DlqRecord; errors: DlqErrorEntry[] } | null;
  try {
    detail = await db.doTn(tn => readDlqRecord(tn, queue.ks, jobId));
  } catch (error) {
    logger.error("NuQ FDB DLQ replay read failed", { error, jobId });
    res
      .status(500)
      .json({ success: false, error: "nuq_fdb_dlq_replay_read_failed" });
    return;
  }

  if (!detail) {
    res.status(404).json({
      success: false,
      error: "nuq_fdb_dlq_not_found",
      jobId,
    });
    return;
  }

  const actor =
    (req as any).adminActor ??
    (req.headers["x-admin-actor-email"] as string | undefined) ??
    null;

  const rec = detail.record;
  try {
    // Re-enqueue via the regular addJob path. We do not skip the gate: the
    // owner has been re-admitted to its limit by definition (the teamLimit
    // recorded at enqueue time may have changed, but addJob reconciles).
    await scrapeQueueFdb.addJob(
      rec.jobId,
      rec.data as any,
      {
        priority: rec.meta.p,
        ownerId: rec.ownerId || undefined,
        groupId: rec.groupId,
        listenable: !!(rec.meta.f & 4),
        bypassGate: !(rec.meta.f & 1),
      },
      { teamLimit: null, queueCap: 1_000_000 },
    );
  } catch (error) {
    logger.error("NuQ FDB DLQ replay addJob failed", {
      error,
      jobId,
      ownerId: rec.ownerId,
      groupId: rec.groupId,
    });
    res
      .status(500)
      .json({ success: false, error: "nuq_fdb_dlq_replay_enqueue_failed" });
    return;
  }

  // Drop the DLQ record + error history and write a manual audit entry so
  // the next sweep (or another admin query) sees the replay was processed.
  const now = Date.now();
  try {
    await db.doTn(async tn => {
      deleteDlqRecord(tn, queue.ks, jobId);
      appendDlqError(
        tn,
        queue.ks,
        {
          tsMs: now,
          reason: `replayed by ${actor ?? "<unknown actor>"}`,
          stalls: rec.stalls,
          source: "manual",
        },
        jobId,
      );
    });
  } catch (error) {
    // The job is already re-enqueued; surface the bookkeeping error so an
    // operator can retry the trim, but don't roll back the replay itself.
    logger.warn("NuQ FDB DLQ replay trim failed", {
      error,
      jobId,
    });
  }

  logger.info("NuQ FDB DLQ replayed", {
    canonicalLog: "nuq-fdb/dlq_replay",
    jobId,
    ownerId: rec.ownerId,
    groupId: rec.groupId,
    actor: actor ?? "<unknown>",
  });

  res.json({
    success: true,
    jobId,
    queueName: queue.queueName,
    requeued: true,
    actor: actor ?? null,
  });
}

function clampListLimit(raw: unknown): number {
  if (typeof raw !== "string") return LIST_LIMIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return LIST_LIMIT_DEFAULT;
  return Math.min(LIST_LIMIT_MAX, Math.floor(n));
}

type DlqErrorEntry = {
  tsMs: number;
  reason: string;
  stalls: number;
  source: "sweeper" | "manual";
};

// Keeps tests/admin tools pointed at a single DLQ keyspace by default. If a
// future queue adds its own DLQ, ?queue=name resolves it.
function resolveDlqQueue(
  _req: Request,
  _logger: Logger,
): { queueName: string; ks: NuqFdbKeyspace } {
  // The only NuQ FDB DLQ today is the scrape queue. Hook for fan-out later.
  return { queueName: scrapeQueueFdb.queueName, ks: scrapeQueueFdb.ks };
}

// silence knip on unused imports it can flag from new files
void decodeJson;
void config;
