import { logger as _logger, devTrace } from "../../lib/logger";
import { config } from "../../config";
import { v7 as uuidv7 } from "uuid";
import {
  finishCrawl,
  getCrawlJobs,
  getDoneJobsOrderedLength,
} from "../../lib/crawl-redis";
import { getCrawl } from "../../lib/crawl-redis";
import { creditsBilledByCrawlId } from "../../db/rpc";
import { getJobs } from "../../controllers/v1/crawl-status";
import { logCrawl, logBatchScrape } from "../logging/log_job";
import { createWebhookSender, WebhookEvent } from "../webhook/index";
import { redisEvictConnection } from "../redis";
import type { Document } from "../../controllers/v2/types";
import type { NuQJob } from "./nuq";

// ---------------------------------------------------------------------------
// PERF-2026-06-17-6: Batch cache precheck helpers.
//
// The v1 batch-scrape controller runs an O(n) Redis lookup against the
// tiered result cache before enqueuing. URLs that hit the cache are
// merged into the batch result store directly via `mergeBatchResult`,
// bypassing the NuQ enqueue path entirely. The crawl-status endpoint
// stitches cache hits back into its result list at read time via
// `getPrecheckCacheHits`, so the user sees a single unified document
// stream regardless of which path each URL took.
//
// Storage layout (per-crawl, all on redisEvictConnection):
//   crawl:<id>:precheck_cache_hits          hash url -> Document JSON
//   crawl:<id>:precheck_cache_hits:order    zset url -> ts (insertion order)
//
// We also stamp a synthetic "pseudo" job id into a separate
// precheck_jobs_done set so the existing crawl-progress accounting
// keeps working: cache hits count as "done" without ever appearing in
// the NuQ jobs set.
// ---------------------------------------------------------------------------

/**
 * Persist a cached scrape result into the batch result store for the given
 * crawl id and mark the URL as done so crawl-progress accounting includes
 * cache-warm URLs. Never throws - failures are logged and swallowed so
 * the precheck path is best-effort and a Redis hiccup cannot break the
 * batch.
 */
export async function mergeBatchResult(
  crawlId: string,
  url: string,
  document: Document,
): Promise<void> {
  try {
    const payload = JSON.stringify(document);
    // Stable pseudo job id so the URL is discoverable across the hash,
    // ordered set, and :jobs_done tracking. The "pc_" prefix avoids any
    // collision with real NuQ job ids (uuidv7 in hex, never starts with
    // "pc_").
    const pseudoJobId = `pc_${uuidv7()}`;
    const ts = Date.now();

    const pipeline = redisEvictConnection.pipeline();
    // 1) Document store keyed by URL.
    pipeline.hset(`crawl:${crawlId}:precheck_cache_hits`, url, payload);
    pipeline.expire(`crawl:${crawlId}:precheck_cache_hits`, 24 * 60 * 60);
    // 2) Ordered insertion so list-by-time stays stable.
    pipeline.zadd(`crawl:${crawlId}:precheck_cache_hits:order`, ts, url);
    pipeline.expire(`crawl:${crawlId}:precheck_cache_hits:order`, 24 * 60 * 60);
    // 3) Mirror the existing addCrawlJobDone bookkeeping so the in-flight
    //    progress counter (scard :jobs_done vs :jobs) closes correctly.
    //    Note: we do NOT add to :jobs (we never enqueued), so this is a
    //    separate "precheck" counter that's added to the totals by
    //    getCrawlJobsForListing callers via getPrecheckCacheHits.
    pipeline.sadd(`crawl:${crawlId}:precheck_jobs_done`, pseudoJobId);
    pipeline.expire(`crawl:${crawlId}:precheck_jobs_done`, 24 * 60 * 60);
    pipeline.zadd(
      `crawl:${crawlId}:precheck_jobs_donez_ordered`,
      ts,
      pseudoJobId,
    );
    pipeline.expire(
      `crawl:${crawlId}:precheck_jobs_donez_ordered`,
      24 * 60 * 60,
    );

    await pipeline.exec();
  } catch (error) {
    _logger.warn("mergeBatchResult: failed to merge cache hit", {
      module: "queue-worker",
      method: "mergeBatchResult",
      crawlId,
      url,
      error,
    });
  }
}

export type PrecheckHit = {
  url: string;
  document: Document;
  ts: number;
};

/**
 * Read all precheck cache hits for a crawl in insertion order. Returns
 * an empty array when the precheck feature wasn't used, the crawl id
 * has expired, or Redis is unreachable (logged, not thrown).
 */
export async function getPrecheckCacheHits(
  crawlId: string,
  start = 0,
  end = -1,
): Promise<PrecheckHit[]> {
  try {
    const urls = await redisEvictConnection.zrange(
      `crawl:${crawlId}:precheck_cache_hits:order`,
      start,
      end,
    );
    if (!urls || urls.length === 0) {
      return [];
    }
    const raws = await redisEvictConnection.hmget(
      `crawl:${crawlId}:precheck_cache_hits`,
      ...urls,
    );
    const scores = await redisEvictConnection.zmscore(
      `crawl:${crawlId}:precheck_cache_hits:order`,
      ...urls,
    );
    const out: PrecheckHit[] = [];
    for (let i = 0; i < urls.length; i++) {
      const raw = raws?.[i];
      const ts = scores?.[i] !== undefined ? Number(scores[i]) : 0;
      if (!raw) continue;
      try {
        out.push({ url: urls[i], document: JSON.parse(raw), ts });
      } catch (error) {
        _logger.warn("getPrecheckCacheHits: malformed document skipped", {
          module: "queue-worker",
          method: "getPrecheckCacheHits",
          crawlId,
          url: urls[i],
          error,
        });
      }
    }
    return out;
  } catch (error) {
    _logger.warn("getPrecheckCacheHits: read failed; returning empty", {
      module: "queue-worker",
      method: "getPrecheckCacheHits",
      crawlId,
      error,
    });
    return [];
  }
}

/**
 * Return the count of cache-hit URLs merged into this crawl so far.
 * Used by crawl-status to compute the "completed" total alongside the
 * NuQ numeric stats.
 */
export async function getPrecheckCacheHitsCount(
  crawlId: string,
): Promise<number> {
  try {
    return await redisEvictConnection.zcard(
      `crawl:${crawlId}:precheck_cache_hits:order`,
    );
  } catch (error) {
    _logger.warn("getPrecheckCacheHitsCount: read failed; returning zero", {
      module: "queue-worker",
      method: "getPrecheckCacheHitsCount",
      crawlId,
      error,
    });
    return 0;
  }
}

export async function finishCrawlSuper(job: NuQJob<any>) {
  const crawlId = job.groupId;

  if (!crawlId) {
    return;
  }

  const sc = await getCrawl(crawlId);

  if (!sc) {
    return;
  }

  const logger = _logger.child({
    module: "queue-worker",
    method: "finishCrawl",
    jobId: job.id,
    scrapeId: job.id,
    crawlId,
    zeroDataRetention: sc.internalOptions.zeroDataRetention,
  });

  // On the FDB backend a completed member's input data is shed for ZDR crawls,
  // so `job.data` can be null here. Prefer the member's job data when present,
  // otherwise recover the crawl-scoped context persisted on the stored crawl.
  const data = job.data;
  const isV1 = data ? !!data.v1 : (sc.v1 ?? true);
  const teamId = data?.team_id ?? sc.team_id;
  const requestId = data?.requestId ?? sc.requestId ?? crawlId;
  const zeroDataRetention = sc.zeroDataRetention || data?.zeroDataRetention;
  const webhook = data?.webhook ?? sc.webhook;
  const monitoring = data?.monitoring;

  logger.info("Finishing crawl");
  await finishCrawl(crawlId, logger);

  if (!isV1) {
    const jobIDs = await getCrawlJobs(crawlId);

    const jobs = (await getJobs(jobIDs)).sort(
      (a, b) => a.timestamp - b.timestamp,
    );
    // const jobStatuses = await Promise.all(jobs.map((x) => x.getState()));
    const jobStatus = sc.cancelled // || jobStatuses.some((x) => x === "failed")
      ? "failed"
      : "completed";

    const fullDocs = jobs
      .map(x =>
        x.returnvalue
          ? Array.isArray(x.returnvalue)
            ? x.returnvalue[0]
            : x.returnvalue
          : null,
      )
      .filter(x => x !== null);

    if (sc.crawlerOptions !== null) {
      await logCrawl(
        {
          id: crawlId,
          request_id: requestId,
          url: sc.originUrl!,
          team_id: teamId,
          options: sc.crawlerOptions,
          num_docs: fullDocs.length,
          credits_cost: fullDocs.reduce(
            (acc, doc) => acc + (doc?.metadata?.creditsUsed ?? 0),
            0,
          ),
          zeroDataRetention,
          cancelled: sc.cancelled ?? false,
          monitor_id: monitoring?.monitorId,
          monitor_check_id: monitoring?.checkId,
        },
        false,
      );
    } else {
      await logBatchScrape(
        {
          id: crawlId,
          request_id: requestId,
          team_id: teamId,
          num_docs: fullDocs.length,
          credits_cost: fullDocs.reduce(
            (acc, doc) => acc + (doc?.metadata?.creditsUsed ?? 0),
            0,
          ),
          zeroDataRetention,
          cancelled: sc.cancelled ?? false,
        },
        false,
      );
    }

    // v0 web hooks, call when done with all the data
    if (!isV1) {
      const sender = await createWebhookSender({
        teamId,
        jobId: crawlId,
        webhook,
        v0: true,
      });
      if (sender) {
        const documents = fullDocs.map((doc: any) => ({
          content: {
            content: doc?.content ?? doc?.rawHtml ?? doc?.markdown ?? "",
            markdown: doc?.markdown,
            metadata: doc?.metadata ?? {},
          },
          source: doc?.metadata?.sourceURL ?? doc?.url ?? "",
        }));
        if (sc.crawlerOptions !== null) {
          sender.send(WebhookEvent.CRAWL_COMPLETED, {
            success: true,
            data: documents,
          });
        } else {
          sender.send(WebhookEvent.BATCH_SCRAPE_COMPLETED, {
            success: true,
            data: documents,
          });
        }
      }
    }
  } else {
    const num_docs = await getDoneJobsOrderedLength(crawlId);

    let credits_billed: number | null = null;

    if (config.USE_DB_AUTHENTICATION) {
      try {
        const creditsRows = await creditsBilledByCrawlId(crawlId);
        credits_billed = creditsRows?.[0]?.credits_billed ?? null;
      } catch (error) {
        logger.warn("Credits billed is null", { error });
      }

      if (credits_billed === null) {
        logger.warn("Credits billed is null", {});
      }
    }

    if (sc.crawlerOptions !== null) {
      await logCrawl(
        {
          id: crawlId,
          request_id: requestId,
          url: sc.originUrl!,
          team_id: teamId,
          options: sc.crawlerOptions,
          num_docs: num_docs,
          credits_cost: credits_billed ?? 0,
          zeroDataRetention,
          cancelled: sc.cancelled ?? false,
          monitor_id: monitoring?.monitorId,
          monitor_check_id: monitoring?.checkId,
        },
        false,
      );
    } else {
      await logBatchScrape(
        {
          id: crawlId,
          request_id: requestId,
          team_id: teamId,
          num_docs: num_docs,
          credits_cost: credits_billed ?? 0,
          zeroDataRetention,
          cancelled: sc.cancelled ?? false,
        },
        false,
      );
    }

    // v1 web hooks, call when done with no data, but with event completed
    if (isV1 && webhook) {
      const sender = await createWebhookSender({
        teamId,
        jobId: crawlId,
        webhook,
        v0: false,
      });
      if (sender) {
        if (sc.crawlerOptions !== null) {
          sender.send(WebhookEvent.CRAWL_COMPLETED, {
            success: true,
            data: [],
          });
        } else {
          sender.send(WebhookEvent.BATCH_SCRAPE_COMPLETED, {
            success: true,
            data: [],
          });
        }
      }
    }
  }

  devTrace("crawl.complete", {
    crawlId,
    teamId,
    isV1,
    cancelled: sc.cancelled ?? false,
    zeroDataRetention,
  });
}
