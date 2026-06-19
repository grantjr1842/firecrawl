import { vi } from "vitest";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";

// hoisted mocks — must precede any import that uses them
const {
  listDlqRecords,
  readDlqRecord,
  deleteDlqRecord,
  appendDlqError,
  scrapeQueueAddJob,
} = vi.hoisted(() => ({
  listDlqRecords: vi.fn(),
  readDlqRecord: vi.fn(),
  deleteDlqRecord: vi.fn(),
  appendDlqError: vi.fn(),
  scrapeQueueAddJob: vi.fn(),
}));

const doTnMock = vi.hoisted(() => vi.fn());

vi.mock("../../config", () => ({
  config: {
    BULL_AUTH_KEY: "test-bull-key",
    SENTRY_DSN: undefined,
    SENTRY_ENVIRONMENT: "test",
    SENTRY_ERROR_SAMPLE_RATE: 1,
    SENTRY_TRACE_SAMPLE_RATE: 0,
    NUQ_POD_NAME: "test-pod",
  },
}));

vi.mock("../../services/worker/nuq-fdb/client", () => ({
  getNuqFdbDatabase: () => ({
    doTn: doTnMock,
  }),
}));

vi.mock("../../services/worker/nuq-fdb", () => ({
  scrapeQueueFdb: {
    queueName: "scrape",
    ks: { dlqRecord: () => ({}), dlqErrorJobRange: () => ({ begin: Buffer.alloc(0), end: Buffer.alloc(0) }) },
    addJob: scrapeQueueAddJob,
  },
}));

vi.mock("../../services/worker/nuq-fdb/ops", () => ({
  listDlqRecords,
  readDlqRecord,
  deleteDlqRecord,
  appendDlqError,
}));

import { wrap } from "../../routes/shared";
import { adminAuthMiddleware } from "../../lib/adminAuth";
import {
  nuqFdbDlqListController,
  nuqFdbDlqReplayController,
} from "../../controllers/v0/admin/nuq-fdb-dlq";

function buildApp() {
  const app = express();
  app.use(express.json());
  // Mount adminAuthMiddleware the same way routes/admin.ts does so tests
  // exercise the same actor-required behavior.
  app.use(adminAuthMiddleware);
  app.get(
    "/admin/test-bull-key/nuq-fdb/dlq/list",
    wrap(nuqFdbDlqListController),
  );
  app.post(
    "/admin/test-bull-key/nuq-fdb/dlq/replay/:jobId",
    wrap(nuqFdbDlqReplayController),
  );
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err?.message ?? "error" });
  });
  return app;
}

describe("nuq-fdb-dlq admin controller (QR-001d)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // default doTn impl: just invoke the callback with a fake transaction so
    // individual tests only have to override the inner helpers.
    doTnMock.mockImplementation(async (fn: any) => fn({}));
  });

  it("GET /dlq/list returns records newest-failed first with error history", async () => {
    const records = [
      {
        jobId: "j-new",
        ownerId: "owner-x",
        groupId: undefined,
        enqueuedAtMs: 100,
        failedAtMs: 200,
        stalls: 9,
        data: { url: "https://a" },
        meta: { c: 100, p: 0, o: "owner-x", f: 1, dc: 1 },
      },
    ];
    listDlqRecords.mockResolvedValueOnce(records);
    readDlqRecord.mockResolvedValueOnce({
      record: records[0],
      errors: [
        { tsMs: 200, reason: "Job stalled too many times", stalls: 9, source: "sweeper" },
      ],
    });

    const app = buildApp();
    const res = await request(app).get(
      "/admin/test-bull-key/nuq-fdb/dlq/list",
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.queueName).toBe("scrape");
    expect(res.body.count).toBe(1);
    expect(res.body.records[0].jobId).toBe("j-new");
    expect(res.body.records[0].errors[0].reason).toMatch(/stalled/i);
  });

  it("GET /dlq/list caps limit to LIST_LIMIT_MAX", async () => {
    listDlqRecords.mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await request(app)
      .get("/admin/test-bull-key/nuq-fdb/dlq/list")
      .query({ limit: "999999" });

    expect(res.status).toBe(200);
    // The controller clamps to LIST_LIMIT_MAX (500); assert the mock got it.
    expect(listDlqRecords).toHaveBeenCalled();
    // listDlqRecords(tn, ks, limit) — third positional is the limit.
    const limitArg = listDlqRecords.mock.calls[0][2];
    expect(typeof limitArg).toBe("number");
    expect(limitArg).toBeLessThanOrEqual(500);
  });

  it("POST /dlq/replay/:jobId without X-Admin-Actor-Email returns 400", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/admin/test-bull-key/nuq-fdb/dlq/replay/j-new")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("admin_actor_required");
    // Should not even try to enqueue — middleware stops it cold.
    expect(scrapeQueueAddJob).not.toHaveBeenCalled();
  });

  it("POST /dlq/replay/:jobId returns 404 when no DLQ record exists", async () => {
    // doTn invokes the callback, which calls readDlqRecord({}); the inner
    // mock returns null → controller sends 404.
    doTnMock.mockImplementationOnce(async (fn: any) => fn({}));
    readDlqRecord.mockResolvedValueOnce(null);

    const app = buildApp();
    const res = await request(app)
      .post("/admin/test-bull-key/nuq-fdb/dlq/replay/missing-job")
      .set("X-Admin-Actor-Email", "ops@firecrawl.dev")
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("nuq_fdb_dlq_not_found");
    expect(scrapeQueueAddJob).not.toHaveBeenCalled();
  });

  it("POST /dlq/replay/:jobId re-enqueues, drops the DLQ record, and audits the actor", async () => {
    const rec = {
      jobId: "j-replay",
      ownerId: "owner-y",
      groupId: "g-1",
      enqueuedAtMs: 10,
      failedAtMs: 50,
      stalls: 9,
      data: { url: "https://r.example" },
      meta: { c: 10, p: 0, o: "owner-y", g: "g-1", f: 5, dc: 1 },
    };
    readDlqRecord.mockResolvedValueOnce({
      record: rec,
      errors: [
        { tsMs: 50, reason: "Job stalled too many times", stalls: 9, source: "sweeper" },
      ],
    });
    scrapeQueueAddJob.mockResolvedValueOnce(undefined);
    deleteDlqRecord.mockResolvedValueOnce(undefined);
    appendDlqError.mockResolvedValueOnce(undefined);
    // First doTn (readDlqRecord) and second doTn (trim) both invoke the
    // supplied callback with a fake transaction. The default fallback impl
    // in beforeEach handles any extras.
    doTnMock.mockImplementationOnce(async (fn: any) => fn({}));
    doTnMock.mockImplementationOnce(async (fn: any) => fn({}));

    const app = buildApp();
    const res = await request(app)
      .post("/admin/test-bull-key/nuq-fdb/dlq/replay/j-replay")
      .set("X-Admin-Actor-Email", "ops@firecrawl.dev")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      jobId: "j-replay",
      requeued: true,
      actor: "ops@firecrawl.dev",
    });
    expect(scrapeQueueAddJob).toHaveBeenCalledWith(
      "j-replay",
      rec.data,
      expect.objectContaining({ ownerId: "owner-y", groupId: "g-1" }),
      expect.any(Object),
    );
    expect(deleteDlqRecord).toHaveBeenCalled();
    expect(appendDlqError).toHaveBeenCalled();
  });
});