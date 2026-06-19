import { randomUUID } from "crypto";
import { config } from "../../config";
import { NuQFdbQueue, NuqFdbSweeper } from "../../services/worker/nuq-fdb";
import {
  getNuqFdbDatabase,
  getFdb,
} from "../../services/worker/nuq-fdb/client";
import {
  listDlqRecords,
  readDlqRecord,
} from "../../services/worker/nuq-fdb/ops";

// QR-001(d) NuQ FDB DLQ. Skipped when FDB is not configured.
const describeIf = config.FDB_CLUSTER_FILE ? describe : describe.skip;

const RUN = randomUUID().slice(0, 8);
const TEST_LEASE_MS = 800;
const createdQueueNames: string[] = [];

async function makeCtx(name: string): Promise<{
  queue: NuQFdbQueue;
  finishedQueue: NuQFdbQueue;
  sweeper: NuqFdbSweeper;
}> {
  const scrapeName = `t-${RUN}-${name}-dlq`;
  const finishedName = `t-${RUN}-${name}-dlq-fin`;
  createdQueueNames.push(scrapeName, finishedName);
  const queue = new NuQFdbQueue(scrapeName, {
    hasGroups: true,
    finishedQueueName: finishedName,
    leaseMs: TEST_LEASE_MS,
  });
  const finishedQueue = new NuQFdbQueue(finishedName, { hasGroups: false });
  const sweeper = new NuqFdbSweeper([queue, finishedQueue]);
  return { queue, finishedQueue, sweeper };
}

function freshOwner(): string {
  return randomUUID();
}

function scrapeData(extra: Record<string, any> = {}): any {
  return { mode: "single_urls", url: "https://example.com", ...extra };
}

const gate = (limit: number, cap: number = 1_000_000) => ({
  teamLimit: limit,
  queueCap: cap,
});

describeIf("NuQ FDB DLQ (QR-001d)", () => {
  afterAll(async () => {
    const fdb = getFdb();
    const db = getNuqFdbDatabase();
    for (const name of createdQueueNames) {
      const r = fdb.tuple.range(["nuq", name]);
      await db.doTn(async tn =>
        tn.clearRange(r.begin as Buffer, r.end as Buffer),
      );
    }
  });

  test("MAX_STALLS exhaustion writes a DLQ record with the original payload", async () => {
    const { queue, sweeper } = await makeCtx("exhaust");
    const owner = freshOwner();
    const id = randomUUID();
    await queue.addJob(
      id,
      scrapeData({ url: "https://dead.example" }),
      {
        ownerId: owner,
      },
      gate(5),
    );

    // Take + let lease expire MAX_STALLS+1 times so the sweeper drives the
    // job from active -> requeue -> ... -> DLQ.
    for (let i = 0; i < 10; i++) {
      const [taken] = await Promise.all([queue.getJobToProcess()]);
      expect(taken?.id).toBe(id);
      await new Promise(resolve => setTimeout(resolve, TEST_LEASE_MS + 150));
      await sweeper.sweepOnce();
    }

    const j = await queue.getJob(id);
    expect(j?.status).toBe("failed");
    expect(j?.failedReason).toMatch(/stalled/i);

    const db = getNuqFdbDatabase();
    const records = await db.doTn(tn => listDlqRecords(tn, queue.ks, 50));
    const rec = records.find(r => r.jobId === id);
    expect(rec).toBeDefined();
    expect(rec?.ownerId).toBe(owner);
    expect((rec?.data as any)?.url).toBe("https://dead.example");
    expect(rec?.stalls).toBeGreaterThanOrEqual(9);

    const detail = await db.doTn(tn => readDlqRecord(tn, queue.ks, id));
    expect(detail).not.toBeNull();
    expect(detail?.errors.length).toBeGreaterThan(0);
    expect(detail?.errors[0]?.reason).toMatch(/stalled/i);
  }, 60_000);

  test("DLQ sweep trims records past DLQ_RECORD_TTL_MS", async () => {
    const { queue, sweeper } = await makeCtx("trim");
    const owner = freshOwner();
    const id = randomUUID();
    await queue.addJob(id, scrapeData(), { ownerId: owner }, gate(5));

    for (let i = 0; i < 10; i++) {
      const taken = await queue.getJobToProcess();
      expect(taken?.id).toBe(id);
      await new Promise(resolve => setTimeout(resolve, TEST_LEASE_MS + 150));
      await sweeper.sweepOnce();
    }

    const db = getNuqFdbDatabase();
    const before = await db.doTn(tn => listDlqRecords(tn, queue.ks, 50));
    expect(before.find(r => r.jobId === id)).toBeDefined();

    // Push the failure timestamp past the TTL by re-writing the record
    // with an enqueuedAt/failedAt far in the past, then sweep again.
    const oldTs = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
    const ks = queue.ks;
    await db.doTn(async tn => {
      const buf = await tn.snapshot().get(ks.dlqRecord(id));
      expect(buf).toBeDefined();
      const rec = JSON.parse(buf!.toString("utf8"));
      rec.failedAtMs = oldTs;
      rec.enqueuedAtMs = oldTs;
      tn.set(ks.dlqRecord(id), Buffer.from(JSON.stringify(rec), "utf8"));
      // also age out the matching error entry so the trim sweep sees it
      const errRange = ks.dlqErrorJobRange(id);
      const rows = await tn
        .snapshot()
        .getRangeAll(errRange.begin, errRange.end);
      for (const [key] of rows) {
        tn.clear(key as Buffer);
      }
    });

    await sweeper.sweepOnce();

    const after = await db.doTn(tn => listDlqRecords(tn, queue.ks, 50));
    expect(after.find(r => r.jobId === id)).toBeUndefined();
  }, 60_000);
});
