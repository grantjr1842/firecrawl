import { createHash } from "crypto";
import { config } from "../../../config";
import { getFdb } from "./client";

// mirrors the uuid package's validate(): RFC 9562 plus the nil/max specials
const UUID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

// RFC 4122 v5 (namespaced SHA-1), matching the uuid package's v5()
function uuidv5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(ns)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// owner IDs can sometimes be non-UUID, so normalize like the PG backend does
const normalizedUUIDNamespace = "0f38e00e-d7ee-4b77-8a7a-a787a3537ca2";
export function normalizeOwnerId(
  ownerId: string | undefined | null,
): string | null {
  if (typeof ownerId !== "string") return null;
  if (UUID_RE.test(ownerId)) return ownerId;
  return uuidv5(ownerId, normalizedUUIDNamespace);
}

// All keys for a queue live under the tuple prefix ("nuq", queueName).
// Counters are 8-byte little-endian signed ints mutated with atomic ADD.

export const READY_SHARDS = config.NUQ_FDB_READY_SHARDS;
export const TEAM_PENDING_SHARDS = config.NUQ_FDB_TEAM_PENDING_SHARDS;
export const TIME_BUCKETS = config.NUQ_FDB_TIME_BUCKETS;

export type NuqFdbJobStatus =
  | "pending" // waiting for a concurrency slot (externally: "backlog")
  | "queued" // holds its slots, in a ready shard
  | "active"
  | "completed"
  | "failed"
  | "cancelled";

// Job flags (bitmask on job meta and queue entries)
export const F_GATED = 1; // holds a team slot while queued/active
export const F_CRAWL_GATED = 2; // holds a crawl slot while team-pending/queued/active
export const F_LISTENABLE = 4;
export const F_ZDR = 8;
export const F_COUNTABLE = 16; // mode === "single_urls": counted in group numeric stats
export const F_GACC = 32; // participates in group remaining-count accounting

// Where a pending job's queue entry lives, stored on its status record so
// sweepers and removers can clear the exact key without scanning.
export type PendingLoc =
  | { k: "tq"; s: number; p: number; c: number } // team-pending: shard, priority, createdAtMs
  | { k: "gq"; p: number; c: number } // crawl-pending: priority, createdAtMs
  | { k: "dl"; at: number }; // delay index: notBeforeMs

export type JobMeta = {
  c: number; // createdAt ms
  p: number; // priority
  o: string; // ownerId (normalized uuid)
  g?: string; // groupId
  f: number; // flags
  to?: number; // backlog timesOutAt ms
  dc: number; // data chunk count
};

export type JobStatusRecord = {
  s: NuqFdbJobStatus;
  l?: string; // lock uuid while active
  e?: number; // lease expiry ms while active
  st: number; // stall count
  fa?: number; // finishedAt ms
  loc?: PendingLoc;
};

// Entry stored in ready shards, pending queues and the delay index.
export type QueueEntry = {
  i: string; // jobId
  o: string; // ownerId
  g?: string; // groupId
  p: number; // priority
  f: number; // flags
  c: number; // createdAt ms
  to?: number; // backlog timesOutAt ms
};

export type GroupMeta = {
  o: string; // ownerId
  c: number; // createdAt ms
  t: number; // ttl ms
  s: "active" | "completed" | "cancelled";
  m?: number; // maxConcurrency
  d?: number; // delay seconds between job starts
  x?: number; // expiresAt ms
};

export function encodeI64(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(n));
  return buf;
}

export function decodeI64(buf: Buffer | undefined | null): number {
  if (!buf || buf.length < 8) return 0;
  return Number(buf.readBigInt64LE());
}

export function encodeJson(v: any): Buffer {
  return Buffer.from(JSON.stringify(v), "utf8");
}

export function decodeJson<T = any>(buf: Buffer | undefined | null): T | null {
  if (!buf) return null;
  return JSON.parse(buf.toString("utf8")) as T;
}

export function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function timeBucket(jobId: string): number {
  return fnv1a(jobId) % TIME_BUCKETS;
}

export function teamPendingShard(jobId: string): number {
  // different rotation than timeBucket so the two don't correlate
  return fnv1a(jobId + "/tq") % TEAM_PENDING_SHARDS;
}

export class NuqFdbKeyspace {
  constructor(public readonly queueName: string) {}

  private pack(parts: any[]): Buffer {
    return getFdb().tuple.pack(["nuq", this.queueName, ...parts]) as Buffer;
  }

  private packRange(parts: any[]): { begin: Buffer; end: Buffer } {
    const r = getFdb().tuple.range(["nuq", this.queueName, ...parts]);
    return { begin: r.begin as Buffer, end: r.end as Buffer };
  }

  // === Job records
  jobMeta(id: string): Buffer {
    return this.pack(["j", id, "m"]);
  }
  jobStatus(id: string): Buffer {
    return this.pack(["j", id, "s"]);
  }
  jobData(id: string, chunk: number): Buffer {
    return this.pack(["j", id, "d", chunk]);
  }
  jobDataRange(id: string) {
    return this.packRange(["j", id, "d"]);
  }
  jobReturnvalue(id: string, chunk: number): Buffer {
    return this.pack(["j", id, "r", chunk]);
  }
  jobReturnvalueRange(id: string) {
    return this.packRange(["j", id, "r"]);
  }
  jobFailedReason(id: string): Buffer {
    return this.pack(["j", id, "f"]);
  }
  jobRange(id: string) {
    return this.packRange(["j", id]);
  }

  // === Team gate
  teamLimit(tid: string): Buffer {
    return this.pack(["t", tid, "limit"]);
  }
  teamActive(tid: string): Buffer {
    return this.pack(["t", tid, "active"]);
  }
  teamPendingCount(tid: string): Buffer {
    return this.pack(["t", tid, "pend"]);
  }
  teamShardCount(tid: string, shard: number): Buffer {
    return this.pack(["t", tid, "qn", shard]);
  }
  teamShardCountRange(tid: string) {
    return this.packRange(["t", tid, "qn"]);
  }
  teamPendingKey(
    tid: string,
    shard: number,
    priority: number,
    createdAtMs: number,
    id: string,
  ): Buffer {
    return this.pack(["t", tid, "q", shard, priority, createdAtMs, id]);
  }
  teamPendingShardRange(tid: string, shard: number) {
    return this.packRange(["t", tid, "q", shard]);
  }

  // === Group (crawl) records
  groupMeta(gid: string): Buffer {
    return this.pack(["g", gid, "meta"]);
  }
  groupRemaining(gid: string): Buffer {
    return this.pack(["g", gid, "rem"]);
  }
  groupCrawlActive(gid: string): Buffer {
    return this.pack(["g", gid, "cact"]);
  }
  groupStatusCount(gid: string, status: string): Buffer {
    return this.pack(["g", gid, "n", status]);
  }
  groupStatusCountRange(gid: string) {
    return this.packRange(["g", gid, "n"]);
  }
  groupPendingCount(gid: string): Buffer {
    return this.pack(["g", gid, "qn"]);
  }
  groupPendingKey(
    gid: string,
    priority: number,
    createdAtMs: number,
    id: string,
  ): Buffer {
    return this.pack(["g", gid, "q", priority, createdAtMs, id]);
  }
  groupPendingRange(gid: string) {
    return this.packRange(["g", gid, "q"]);
  }
  groupJob(gid: string, id: string): Buffer {
    return this.pack(["g", gid, "jobs", id]);
  }
  groupJobRange(gid: string) {
    return this.packRange(["g", gid, "jobs"]);
  }
  groupDonePrefix(gid: string): Buffer {
    return this.pack(["g", gid, "done"]);
  }
  groupDoneRange(gid: string) {
    return this.packRange(["g", gid, "done"]);
  }
  groupFinishedJob(gid: string): Buffer {
    return this.pack(["g", gid, "fjob"]);
  }
  groupRange(gid: string) {
    return this.packRange(["g", gid]);
  }
  ongoingGroup(ownerId: string, gid: string): Buffer {
    return this.pack(["go", ownerId, gid]);
  }
  ongoingGroupRange(ownerId: string) {
    return this.packRange(["go", ownerId]);
  }

  // === Ready shards
  readyPrefix(shard: number, priority: number): Buffer {
    return this.pack(["r", shard, "q", priority]);
  }
  readyShardRange(shard: number) {
    return this.packRange(["r", shard, "q"]);
  }
  readyShardCount(shard: number): Buffer {
    return this.pack(["rn", shard]);
  }
  readyShardCountRange() {
    return this.packRange(["rn"]);
  }

  // === Time-ordered indexes (sweeper-owned)
  lease(bucket: number, expMs: number, id: string): Buffer {
    return this.pack(["lease", bucket, expMs, id]);
  }
  leaseScanRange(bucket: number, untilMs: number) {
    return {
      begin: this.pack(["lease", bucket]),
      end: this.pack(["lease", bucket, untilMs]),
    };
  }
  backlogTimeout(bucket: number, atMs: number, id: string): Buffer {
    return this.pack(["bto", bucket, atMs, id]);
  }
  backlogTimeoutScanRange(bucket: number, untilMs: number) {
    return {
      begin: this.pack(["bto", bucket]),
      end: this.pack(["bto", bucket, untilMs]),
    };
  }
  delayed(bucket: number, notBeforeMs: number, id: string): Buffer {
    return this.pack(["delay", bucket, notBeforeMs, id]);
  }
  delayedScanRange(bucket: number, untilMs: number) {
    return {
      begin: this.pack(["delay", bucket]),
      end: this.pack(["delay", bucket, untilMs]),
    };
  }
  jobExpiry(bucket: number, atMs: number, id: string): Buffer {
    return this.pack(["jexp", bucket, atMs, id]);
  }
  jobExpiryScanRange(bucket: number, untilMs: number) {
    return {
      begin: this.pack(["jexp", bucket]),
      end: this.pack(["jexp", bucket, untilMs]),
    };
  }
  groupExpiry(atMs: number, gid: string): Buffer {
    return this.pack(["gexp", atMs, gid]);
  }
  groupExpiryScanRange(untilMs: number) {
    return {
      begin: this.pack(["gexp"]),
      end: this.pack(["gexp", untilMs]),
    };
  }

  // === Task keys (blind-set, sweeper-drained)
  taskGroupFinish(gid: string): Buffer {
    return this.pack(["task", "gfin", gid]);
  }
  taskGroupFinishRange() {
    return this.packRange(["task", "gfin"]);
  }
  taskGroupCancel(gid: string): Buffer {
    return this.pack(["task", "gcancel", gid]);
  }
  taskGroupCancelRange() {
    return this.packRange(["task", "gcancel"]);
  }
  taskTeamRaise(tid: string): Buffer {
    return this.pack(["task", "traise", tid]);
  }
  taskTeamRaiseRange() {
    return this.packRange(["task", "traise"]);
  }
  sweeperLock(): Buffer {
    return this.pack(["sweep", "lock"]);
  }

  unpackId(key: Buffer, indexFromEnd: number = 0): string {
    const parts = getFdb().tuple.unpack(key);
    return String(parts[parts.length - 1 - indexFromEnd]);
  }
}
