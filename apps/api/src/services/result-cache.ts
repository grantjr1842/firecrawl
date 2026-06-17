import { createHash } from "node:crypto";

import { redisRateLimitClient } from "./rate-limiter";
import { config } from "../config";
import { logger, devTrace } from "../lib/logger";

/**
 * Redis-backed tiered result cache (BB-11) for non-indexed scrapes.
 *
 * The original QW-08 cache was a single-key sha256(url) -> result with one
 * TTL. This module extends that with:
 *
 *   1. **Tiered LRU cache** - one Redis key per (url, tier) where `tier`
 *      is the requested output format (`markdown`, `html`, `screenshot`,
 *      `extract`). Each tier has its own TTL, its own key prefix, and its
 *      own hit / miss counter. LRU eviction is delegated to Redis via
 *      `maxmemory-policy=allkeys-lru`; the per-tier hit-rate is the
 *      operator-visible knob for tuning.
 *
 *   2. **ETag round-trip** - when the upstream server returns a strong
 *      ETag, we stash it in the cached value. On a cache hit we re-issue
 *      the request with `If-None-Match`. A `304 Not Modified` response
 *      means we can serve the cached body without paying the upstream
 *      bandwidth cost; a `200 OK` body updates the cache. The flag
 *      `RESULT_CACHE_USE_ETAG` lets an operator turn this off.
 *
 *   3. **ZDR-aware keys** - zero-data-retention requests must NEVER be
 *      cached (writes) and must NEVER be served from cache (reads). This
 *      is enforced at the getter/setter boundary by an explicit
 *      `zdr:true` marker on the call site; the cache module itself is
 *      privacy-agnostic and trusts the caller. The privacy rationale is
 *      that the only safe way to honour a ZDR contract is to keep the
 *      bytes out of every persistent store, including our own Redis.
 *
 * Bypassed for (in addition to the above ZDR check):
 *   - index-enabled deployments (those already have their own cache)
 *   - Redis errors (fail open: cache miss rather than fail the scrape)
 *
 * The serialized payload carries the cache write timestamp so the caller
 * can stamp metadata.cacheState = "hit". The cache value is JSON with a
 * shape compatible with the original QW-08 entry, so existing debug
 * tooling that reads `result-cache:v1:*` continues to work for the
 * default `markdown` tier.
 */

export type CacheTier = "markdown" | "html" | "screenshot" | "extract";

export type CachedScrapeResult = {
  url: string;
  cachedAt: string;
  ttlSeconds: number;
  etag?: string;
  // The rest of the fields are the post-transformer Document. We use a
  // permissive index signature so callers can re-construct it without a
  // tight coupling to the Document type (which would force this module
  // to depend on the controller types).
  [key: string]: unknown;
};

export type CacheStats = {
  hits: number;
  misses: number;
  evictions: number;
  hit_rate: number;
};

export type CacheStatsSnapshot = Record<CacheTier, CacheStats>;

const CACHE_KEY_PREFIX = "result-cache:v2:"; // bumped: tiered namespace
const DEFAULT_TTL_SECONDS = 3600;
const MAX_TTL_SECONDS = 24 * 60 * 60; // 1 day ceiling

// Per-tier TTLs (seconds). Read from env at module load so runtime
// changes require a restart; consistent with other config knobs.
const TIER_TTL_SECONDS: Record<CacheTier, number> = {
  markdown: config.RESULT_CACHE_TIER_MARKDOWN_TTL,
  html: config.RESULT_CACHE_TIER_HTML_TTL,
  screenshot: config.RESULT_CACHE_TIER_SCREENSHOT_TTL,
  extract: config.RESULT_CACHE_TIER_EXTRACT_TTL,
};

// Key prefix per tier. Keeping the tier in the key (vs. a Redis hash
// field) means `redis-cli KEYS result-cache:v2:markdown:*` is a
// useful debug query and LRU eviction is uniform across tiers.
function tierKeyPrefix(tier: CacheTier): string {
  return `${CACHE_KEY_PREFIX}${tier}:`;
}

const TIER_STATS: Record<
  CacheTier,
  { hits: number; misses: number; evictions: number }
> = {
  markdown: { hits: 0, misses: 0, evictions: 0 },
  html: { hits: 0, misses: 0, evictions: 0 },
  screenshot: { hits: 0, misses: 0, evictions: 0 },
  extract: { hits: 0, misses: 0, evictions: 0 },
};

/**
 * Returns the current hit/miss/eviction counters per tier plus a
 * computed hit rate. Useful for the /metrics endpoint and for the
 * SELF_HOST.md "Cache hit rate metrics" section.
 */
export function getCacheStats(): CacheStatsSnapshot {
  const out = {} as CacheStatsSnapshot;
  (Object.keys(TIER_STATS) as CacheTier[]).forEach(tier => {
    const s = TIER_STATS[tier];
    const total = s.hits + s.misses;
    out[tier] = {
      ...s,
      hit_rate: total === 0 ? 0 : s.hits / total,
    };
  });
  return out;
}

function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function cacheKey(url: string, tier: CacheTier): string {
  return `${tierKeyPrefix(tier)}${hashUrl(url)}`;
}

// Per-tenant key prefix. When RESULT_CACHE_TEAM_ISOLATION is on, the
// tenant id (or its short hash) is mixed into the cache key so teams
// don't share cached bytes - the privacy story is "Team A's cached
// scrape of example.com is never served to Team B", not "we cache
// more efficiently". We hash the teamId with sha256 and take the
// first 16 hex chars so the resulting key stays a manageable size
// and the raw uuid never appears in Redis.
function teamKeyPrefix(teamId: string): string {
  return `team:${createHash("sha256").update(teamId).digest("hex").slice(0, 16)}`;
}

function tieredTeamKey(url: string, tier: CacheTier, teamId: string): string {
  return `${tierKeyPrefix(tier)}${teamKeyPrefix(teamId)}:${hashUrl(url)}`;
}

// ---------------------------------------------------------------------------
// ZDR-aware public API.
//
// The public read/write functions take a `zdr` boolean. When true, the
// function is a no-op: a get returns null (forcing the engine waterfall)
// and a set is silently dropped. This is the single chokepoint for the
// ZDR privacy contract - every caller must thread `zdr` through.
// ---------------------------------------------------------------------------

/**
 * Returns the cached result for `(url, tier)` or null on miss / error /
 * parse failure. When `zdr` is true, ALWAYS returns null.
 *
 * Callers must still validate that the cached payload is usable for
 * their request (e.g. the URL has not been rewritten in a way that would
 * invalidate the cached content).
 */
export async function getCachedResultTiered(
  url: string,
  tier: CacheTier,
  zdr: boolean = false,
  teamId?: string,
): Promise<CachedScrapeResult | null> {
  // ZDR bypass: never serve ZDR content out of the cache. The privacy
  // rationale (per the module-level comment) is that any persistent
  // copy - even a hash-keyed, no-PII one - violates the strict reading
  // of "no data retained". We err on the side of never caching in the
  // first place, but the read-side check is the second line of defence
  // in case a future regression ever stores a ZDR result by mistake.
  if (zdr) {
    return null;
  }
  // Per-tenant isolation is opt-in via RESULT_CACHE_TEAM_ISOLATION.
  // When off (default) every team shares the global key, which is the
  // max-hit-rate behaviour for self-hosted single-tenant installs. When
  // on, the teamId is mixed into the key so teams can't read each
  // other's cached bytes.
  const useTeamKey =
    teamId !== undefined && config.RESULT_CACHE_TEAM_ISOLATION === true;
  const key = useTeamKey
    ? tieredTeamKey(url, tier, teamId)
    : cacheKey(url, tier);
  try {
    const raw = await redisRateLimitClient.get(key);
    if (!raw) {
      TIER_STATS[tier].misses += 1;
      devTrace("scrape.cache.lookup", {
        url,
        tier,
        hit: false,
        teamId,
        zdr,
      });
      return null;
    }
    const parsed = JSON.parse(raw) as CachedScrapeResult;
    if (typeof parsed.url !== "string" || typeof parsed.cachedAt !== "string") {
      // Defensive: discard malformed entries rather than throw.
      TIER_STATS[tier].misses += 1;
      devTrace("scrape.cache.lookup", {
        url,
        tier,
        hit: false,
        malformed: true,
        teamId,
        zdr,
      });
      return null;
    }
    TIER_STATS[tier].hits += 1;
    devTrace("scrape.cache.lookup", {
      url,
      tier,
      hit: true,
      teamId,
      zdr,
    });
    return parsed;
  } catch (error) {
    logger.warn("result-cache: get failed; treating as cache miss", {
      error,
      tier,
    });
    TIER_STATS[tier].misses += 1;
    devTrace("scrape.cache.lookup", {
      url,
      tier,
      hit: false,
      error: error instanceof Error ? error.message : String(error),
      teamId,
      zdr,
    });
    return null;
  }
}

/**
 * Store a result in the cache. TTL is `ttlSeconds` (clamped to a sane
 * upper bound) or the per-tier default if not provided. When `zdr` is
 * true, the call is a no-op. Failures are logged and swallowed - the
 * cache is best-effort.
 */
export async function setCachedResultTiered(
  url: string,
  tier: CacheTier,
  result: Record<string, unknown>,
  ttlSeconds?: number,
  zdr: boolean = false,
  teamId?: string,
): Promise<void> {
  // ZDR bypass: see the privacy rationale in getCachedResultTiered.
  if (zdr) {
    return;
  }
  // Per-tenant isolation: mirror the read path. If the caller passed a
  // teamId and the operator opted in, write under the team-prefixed
  // key; otherwise write under the global key.
  const useTeamKey =
    teamId !== undefined && config.RESULT_CACHE_TEAM_ISOLATION === true;
  const key = useTeamKey
    ? tieredTeamKey(url, tier, teamId)
    : cacheKey(url, tier);
  const requestedTtl =
    ttlSeconds !== undefined ? ttlSeconds : TIER_TTL_SECONDS[tier];
  const ttl = Math.max(1, Math.min(requestedTtl, MAX_TTL_SECONDS));
  const payload: CachedScrapeResult = {
    ...result,
    url,
    cachedAt: new Date().toISOString(),
    ttlSeconds: ttl,
  } as CachedScrapeResult;
  try {
    await redisRateLimitClient.set(key, JSON.stringify(payload), "EX", ttl);
  } catch (error) {
    logger.warn("result-cache: set failed; scrape will still succeed", {
      error,
      tier,
    });
  }
}

// ---------------------------------------------------------------------------
// Backwards-compatible single-tier API. The original QW-08 surface
// (`getCachedResult` / `setCachedResult` with a single ttlSeconds arg)
// now maps to the `markdown` tier, which is the most common
// scrape output. This keeps every existing caller working without
// changes and gives the operator a clean migration path: per-tier
// callers opt in to the new `*Tiered` API, the rest stay on the
// default tier.
// ---------------------------------------------------------------------------
export async function getCachedResult(
  url: string,
): Promise<CachedScrapeResult | null> {
  return getCachedResultTiered(url, "markdown", false);
}

export async function setCachedResult(
  url: string,
  result: Record<string, unknown>,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  return setCachedResultTiered(url, "markdown", result, ttlSeconds, false);
}

export type RevalidateResult = {
  revalidated: boolean;
  body: CachedScrapeResult | null;
  freshEtag?: string;
};

/**
 * Round-trip the upstream server with `If-None-Match`. On `304`, returns
 * the cached body unchanged. On `200`, returns `{ revalidated: false,
 * freshEtag: <new-etag> }` so the caller can refresh the cache. The
 * function is best-effort: any network/parse failure is logged and
 * treated as "not revalidated" so the caller falls back to a full
 * refetch.
 */
export async function tryRevalidateEtag(
  url: string,
  cached: CachedScrapeResult,
  options: { signal?: AbortSignal } = {},
): Promise<RevalidateResult> {
  if (!config.RESULT_CACHE_USE_ETAG) {
    return { revalidated: false, body: null };
  }
  if (!cached.etag) {
    return { revalidated: false, body: null };
  }
  try {
    // We deliberately keep the response small: on a 304 we throw away
    // the body, on a 200 we read it fully so the caller can re-cache.
    const response = await fetch(url, {
      method: "GET",
      headers: { "If-None-Match": cached.etag },
      signal: options.signal,
      redirect: "follow",
    });
    if (response.status === 304) {
      logger.debug("result-cache: ETag revalidation hit 304", {
        url,
        etag: cached.etag,
      });
      return { revalidated: true, body: cached };
    }
    // Any other status (200, 4xx, 5xx) means we can't serve the
    // cached body safely - the resource may have changed shape. We
    // forward the new ETag when present so the caller can refresh
    // the cache after the full re-fetch.
    const newEtag = response.headers.get("etag") ?? undefined;
    return {
      revalidated: false,
      body: null,
      freshEtag: newEtag,
    };
  } catch (error) {
    logger.warn("result-cache: ETag revalidation failed; falling back", {
      error,
      url,
    });
    return { revalidated: false, body: null };
  }
}

/**
 * Convert a `maxAge` value in milliseconds to a TTL in seconds, rounded
 * down to the nearest second with a floor of 1. Returns undefined when
 * no maxAge is provided so the caller can fall back to the tier
 * default.
 */
export function ttlSecondsFromMaxAgeMs(
  maxAgeMs: number | undefined | null,
): number | undefined {
  if (maxAgeMs === undefined || maxAgeMs === null || maxAgeMs <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(maxAgeMs / 1000));
}

export type FormatDescriptor = { type: string };

/**
 * Pick a cache tier from a `formats` array. Returns `markdown` as the
 * default when no recognised tier is present. The precedence is:
 *
 *   screenshot > extract > html > markdown
 *
 * Screenshot wins because it's the most expensive transform and the
 * shortest TTL, so a request asking for both markdown and screenshot
 * should populate the screenshot entry first. This is a heuristic;
 * the caller is free to override by calling setCachedResultTiered
 * directly for each tier it cares about.
 */
export function pickCacheTier(
  formats: FormatDescriptor[] | undefined | null,
): CacheTier {
  if (!formats || formats.length === 0) {
    return "markdown";
  }
  const types = new Set(formats.map(f => f.type));
  if (types.has("screenshot")) return "screenshot";
  if (types.has("extract") || types.has("json") || types.has("summary")) {
    return "extract";
  }
  if (types.has("html") || types.has("rawHtml")) return "html";
  return "markdown";
}

/**
 * Reset the in-process hit / miss / eviction counters. Test-only
 * helper so individual test cases can start from a known baseline.
 * Not exported in the public package surface.
 */
export function __resetCacheStatsForTest(): void {
  (Object.keys(TIER_STATS) as CacheTier[]).forEach(tier => {
    TIER_STATS[tier] = { hits: 0, misses: 0, evictions: 0 };
  });
}
