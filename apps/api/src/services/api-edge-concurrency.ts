// QR-001(b): API-edge load-shedding concurrency limiter.
//
// Sits at the API controllers (v2 scrape, v2 crawl) and rejects requests
// that would push a team's in-flight count past a configured cap. The
// check is non-blocking: when the cap is hit, the controller returns
// 429 with a Retry-After header instead of queuing inside the request.
//
// Implementation: a per-team Redis ZSET keyed at the API-edge client
// (rate-limiter Redis). Each in-flight request inserts an entry scored
// by its lease expiry; acquire() trims expired entries, counts the
// survivors, and inserts the new holder if the team is below the cap.
// Release() removes the holder. On reject, acquire() returns the lease
// expiry of the soonest-to-expire holder so the caller can compute a
// Retry-After hint.
//
// Distinct from services/worker/team-semaphore.ts: that semaphore lives
// in the NuQ Redis client, gates the worker's local concurrency pool,
// and blocks with backoff. This one lives at the API edge, fails fast,
// and is sized much higher because it's protecting the public API
// (where many concurrent clients connect for one team) rather than a
// single worker's local slot count.
import { redisRateLimitClient } from "./rate-limiter";
import { logger as _logger } from "../lib/logger";
import { Gauge } from "prom-client";

const logger = _logger.child({ module: "api-edge-concurrency" });

const PREFIX = "api-edge-conc:";

// Per-team ZSET key holding in-flight holder ids scored by lease expiry
// (unix ms). Encoded as `<PREFIX><endpoint>:<team_id>` so the same team
// can have separate scrape and crawl caps.
const key = (endpoint: string, teamId: string) =>
  `${PREFIX}${endpoint}:${teamId}`;

const trimScript = `
local t = redis.call('TIME')
local now_ms = t[1] * 1000 + math.floor(t[2] / 1000)
local removed = redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)
return {removed, redis.call('ZCARD', KEYS[1])}
`;

const acquireScript = `
local t = redis.call('TIME')
local now_ms = t[1] * 1000 + math.floor(t[2] / 1000)
local lease_ttl_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

-- Trim expired entries first so a leaked holder can't permanently
-- shrink the cap for a team.
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)

local in_use = tonumber(redis.call('ZCARD', KEYS[1]))

if in_use >= limit then
  -- Surface the soonest-to-expire holder so the caller can return a
  -- Retry-After hint aligned with real capacity, not a guess.
  local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local nextExpiryMs = 0
  if first and first[2] then
    nextExpiryMs = tonumber(first[2])
  end
  return {0, in_use, nextExpiryMs}
end

local holder = ARGV[1]
local exp = now_ms + lease_ttl_ms
redis.call('ZADD', KEYS[1], exp, holder)
return {1, in_use + 1, exp}
`;

const releaseScript = `
return redis.call('ZREM', KEYS[1], ARGV[1])
`;

const countScript = `
local t = redis.call('TIME')
local now_ms = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)
return redis.call('ZCARD', KEYS[1])
`;

const trimHash = { script: "LOAD", trim: "" } as { trim: string };
const acquireHash = { acquire: "" } as { acquire: string };
const releaseHash = { release: "" } as { release: string };
const countHash = { count: "" } as { count: string };

let initPromise: Promise<void> | null = null;
async function ensureScriptsLoaded(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    trimHash.trim = (await redisRateLimitClient.script(
      "LOAD",
      trimScript,
    )) as string;
    acquireHash.acquire = (await redisRateLimitClient.script(
      "LOAD",
      acquireScript,
    )) as string;
    releaseHash.release = (await redisRateLimitClient.script(
      "LOAD",
      releaseScript,
    )) as string;
    countHash.count = (await redisRateLimitClient.script(
      "LOAD",
      countScript,
    )) as string;
  })().catch(err => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

const inFlightGauge = new Gauge({
  name: "api_edge_concurrency_in_flight",
  help: "In-flight API-edge concurrency holders, labelled by endpoint",
  labelNames: ["endpoint"] as const,
});

const rejectedCounter = new Gauge({
  name: "api_edge_concurrency_rejected_total",
  help: "Total 429s issued by the API-edge concurrency limiter",
  labelNames: ["endpoint"] as const,
});

export type AcquireResult =
  | { granted: true; count: number }
  | {
      granted: false;
      count: number;
      // Lease expiry (ms since epoch) of the soonest-to-expire holder
      // on the team. The caller computes Retry-After from this.
      nextExpiryMs: number;
    };

export async function acquireApiEdgeSlot(
  endpoint: string,
  teamId: string,
  holderId: string,
  limit: number,
  leaseTtlMs: number,
): Promise<AcquireResult> {
  if (limit <= 0) {
    // 0 disables the limiter for this endpoint. This lets operators
    // turn off the cap without removing env wiring (e.g. during a
    // postmortem where load-shedding itself is suspected).
    return { granted: true, count: 0 };
  }
  await ensureScriptsLoaded();

  let granted: number;
  let count: number;
  let nextExpiryMs: number;
  try {
    const res = (await redisRateLimitClient.evalsha(
      acquireHash.acquire,
      1,
      key(endpoint, teamId),
      holderId,
      String(leaseTtlMs),
      String(limit),
    )) as [number, number, number];
    [granted, count, nextExpiryMs] = res;
  } catch (err) {
    // If Redis is down, fail open. The team-semaphore downstream still
    // gates real concurrency against the worker pool, so the worst case
    // is we let a few extra requests through to NuQ.
    logger.warn("acquireApiEdgeSlot failed, failing open", {
      endpoint,
      teamId,
      error: (err as Error).message,
    });
    return { granted: true, count: 0 };
  }

  if (granted === 1) {
    inFlightGauge.labels(endpoint).set(count);
    return { granted: true, count };
  }

  rejectedCounter.labels(endpoint).inc();
  return { granted: false, count, nextExpiryMs };
}

export async function releaseApiEdgeSlot(
  endpoint: string,
  teamId: string,
  holderId: string,
): Promise<void> {
  if (!holderId) return;
  await ensureScriptsLoaded();
  try {
    await redisRateLimitClient.evalsha(
      releaseHash.release,
      1,
      key(endpoint, teamId),
      holderId,
    );
    const remaining = (await redisRateLimitClient.evalsha(
      countHash.count,
      1,
      key(endpoint, teamId),
    )) as number;
    inFlightGauge.labels(endpoint).set(remaining);
  } catch (err) {
    logger.warn("releaseApiEdgeSlot failed", {
      endpoint,
      teamId,
      holderId,
      error: (err as Error).message,
    });
  }
}

export async function countApiEdgeInFlight(
  endpoint: string,
  teamId: string,
): Promise<number> {
  await ensureScriptsLoaded();
  try {
    return (await redisRateLimitClient.evalsha(
      countHash.count,
      1,
      key(endpoint, teamId),
    )) as number;
  } catch {
    return 0;
  }
}
