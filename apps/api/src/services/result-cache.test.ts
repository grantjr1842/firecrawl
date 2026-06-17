import { vi } from "vitest";
import { createHash } from "node:crypto";

// -----------------------------------------------------------------------------
// In-memory Redis stand-in. Mirrors the bits the cache module uses (get/set
// with optional "EX" ttl). We instantiate MockRedis once and re-use the same
// instance for the rate-limiter module mock, since the cache module imports
// the same symbol.
//
// vi.mock is hoisted to the top of the file, so anything its factories
// reference must be created in vi.hoisted() (which also hoists).
// -----------------------------------------------------------------------------
const { store, mockGet, mockSet, sharedRedis } = vi.hoisted(() => {
  const store = new Map<string, { value: string; expiresAt: number }>();

  const mockGet = vi.fn((key: string) => {
    const entry = store.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt < Date.now()) {
      store.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  });

  const mockSet = vi.fn((key: string, value: string, ...rest: unknown[]) => {
    // The cache module always passes ("EX", ttl) — we model that.
    let expiresAt = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "EX" && i + 1 < rest.length) {
        const ttlSec = Number(rest[i + 1]);
        if (Number.isFinite(ttlSec)) {
          expiresAt = Date.now() + ttlSec * 1000;
        }
      }
    }
    store.set(key, { value, expiresAt });
    return Promise.resolve("OK");
  });

  class MockRedis {
    get = mockGet;
    set = mockSet;
    constructor(_url: string) {}
  }

  const sharedRedis = new MockRedis("");

  return { store, mockGet, mockSet, sharedRedis };
});

vi.mock("./rate-limiter", () => ({
  redisRateLimitClient: sharedRedis,
}));

vi.mock("../config", () => ({
  config: {
    RESULT_CACHE_TIER_MARKDOWN_TTL: 3600,
    RESULT_CACHE_TIER_HTML_TTL: 1800,
    RESULT_CACHE_TIER_SCREENSHOT_TTL: 600,
    RESULT_CACHE_TIER_EXTRACT_TTL: 300,
    RESULT_CACHE_USE_ETAG: true,
    RESULT_CACHE_MAX_KEYS: 100000,
    RESULT_CACHE_TEAM_ISOLATION: false,
  },
}));

import {
  __resetCacheStatsForTest,
  getCacheStats,
  getCachedResult,
  getCachedResultTiered,
  pickCacheTier,
  setCachedResult,
  setCachedResultTiered,
  tryRevalidateEtag,
  ttlSecondsFromMaxAgeMs,
} from "./result-cache";

const URL = "https://example.com/page";
const OTHER_URL = "https://example.com/other";

function hashOf(url: string): string {
  // Mirror the sha256 hashing the cache module uses, so we can build
  // the expected key without reaching into private helpers.
  return createHash("sha256").update(url).digest("hex");
}

describe("result-cache (BB-11 tiered LRU + ETag + ZDR)", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    __resetCacheStatsForTest();
  });

  // ---- Per-tier TTL / key prefix ---------------------------------------
  it("stores entries under a per-tier key prefix", async () => {
    await setCachedResultTiered(URL, "markdown", {
      url: URL,
      statusCode: 200,
      markdown: "hi",
    });
    await setCachedResultTiered(URL, "html", {
      url: URL,
      statusCode: 200,
      html: "<p>hi</p>",
    });
    await setCachedResultTiered(URL, "screenshot", {
      url: URL,
      statusCode: 200,
      screenshot: "base64",
    });
    await setCachedResultTiered(URL, "extract", {
      url: URL,
      statusCode: 200,
      markdown: "extract me",
    });

    const keys = Array.from(store.keys());
    expect(keys).toHaveLength(4);
    const byTier = new Set(keys.map(k => k.split(":")[2]));
    expect(byTier).toEqual(
      new Set(["markdown", "html", "screenshot", "extract"]),
    );
  });

  it("writes per-tier entries with the per-tier TTL (markdown=3600s, screenshot=600s)", async () => {
    await setCachedResultTiered(URL, "markdown", {
      url: URL,
      statusCode: 200,
      markdown: "hi",
    });
    await setCachedResultTiered(URL, "screenshot", {
      url: URL,
      statusCode: 200,
      screenshot: "base64",
    });
    const mdKey = `result-cache:v2:markdown:${hashOf(URL)}`;
    const ssKey = `result-cache:v2:screenshot:${hashOf(URL)}`;
    const mdEntry = store.get(mdKey);
    const ssEntry = store.get(ssKey);
    expect(mdEntry).toBeDefined();
    expect(ssEntry).toBeDefined();
    const mdTtl = (mdEntry!.expiresAt - Date.now()) / 1000;
    const ssTtl = (ssEntry!.expiresAt - Date.now()) / 1000;
    // Allow a 5s slack for test clock drift.
    expect(mdTtl).toBeGreaterThan(3595);
    expect(mdTtl).toBeLessThan(3601);
    expect(ssTtl).toBeGreaterThan(595);
    expect(ssTtl).toBeLessThan(601);
  });

  it("honours a caller-supplied TTL and clamps it to the 1-day ceiling", async () => {
    await setCachedResultTiered(
      URL,
      "html",
      { url: URL, statusCode: 200, html: "<p/>" },
      30,
    );
    await setCachedResultTiered(
      OTHER_URL,
      "html",
      { url: OTHER_URL, statusCode: 200, html: "<p/>" },
      30 * 24 * 60 * 60 + 9999,
    );
    const short = store.get(`result-cache:v2:html:${hashOf(URL)}`);
    const long = store.get(`result-cache:v2:html:${hashOf(OTHER_URL)}`);
    expect((short!.expiresAt - Date.now()) / 1000).toBeLessThan(31);
    expect((long!.expiresAt - Date.now()) / 1000).toBeLessThanOrEqual(86400);
  });

  // ---- ETag round-trip ------------------------------------------------
  it("stores and returns the upstream ETag alongside the body", async () => {
    await setCachedResultTiered(URL, "markdown", {
      url: URL,
      statusCode: 200,
      markdown: "hello",
      etag: 'W/"abc-123"',
    });
    const cached = await getCachedResultTiered(URL, "markdown", false);
    expect(cached).not.toBeNull();
    expect(cached?.etag).toBe('W/"abc-123"');
  });

  it("tryRevalidateEtag returns the cached body on a 304 from upstream", async () => {
    const cached = {
      url: URL,
      statusCode: 200,
      markdown: "stale-but-valid",
      cachedAt: new Date().toISOString(),
      ttlSeconds: 3600,
      etag: '"v1"',
    };
    const realFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(null, { status: 304 }));
    try {
      const result = await tryRevalidateEtag(URL, cached);
      expect(result.revalidated).toBe(true);
      expect(result.body?.markdown).toBe("stale-but-valid");
    } finally {
      global.fetch = realFetch;
    }
  });

  it("tryRevalidateEtag returns freshEtag on a 200 from upstream", async () => {
    const cached = {
      url: URL,
      statusCode: 200,
      markdown: "stale",
      cachedAt: new Date().toISOString(),
      ttlSeconds: 3600,
      etag: '"v1"',
    };
    const realFetch = global.fetch;
    global.fetch = vi.fn(
      async () =>
        new Response("new body", {
          status: 200,
          headers: { etag: '"v2"' },
        }),
    );
    try {
      const result = await tryRevalidateEtag(URL, cached);
      expect(result.revalidated).toBe(false);
      expect(result.freshEtag).toBe('"v2"');
    } finally {
      global.fetch = realFetch;
    }
  });

  // ---- ZDR bypass -----------------------------------------------------
  it("ZDR reads ALWAYS return null, even when an entry exists", async () => {
    await setCachedResultTiered(URL, "markdown", {
      url: URL,
      statusCode: 200,
      markdown: "secret",
    });
    const cached = await getCachedResultTiered(URL, "markdown", true);
    expect(cached).toBeNull();
  });

  it("ZDR writes are a no-op - the entry is NOT created", async () => {
    await setCachedResultTiered(
      URL,
      "markdown",
      { url: URL, statusCode: 200, markdown: "secret" },
      undefined,
      true,
    );
    expect(store.size).toBe(0);
  });

  // ---- Cache stats ----------------------------------------------------
  it("getCacheStats tracks hits, misses, and hit_rate per tier", async () => {
    await setCachedResultTiered(URL, "markdown", {
      url: URL,
      statusCode: 200,
      markdown: "hi",
    });
    // 2 hits
    await getCachedResultTiered(URL, "markdown", false);
    await getCachedResultTiered(URL, "markdown", false);
    // 1 miss
    await getCachedResultTiered(OTHER_URL, "markdown", false);
    const stats = getCacheStats();
    expect(stats.markdown.hits).toBe(2);
    expect(stats.markdown.misses).toBe(1);
    expect(stats.markdown.hit_rate).toBeCloseTo(2 / 3, 5);
    // Other tiers untouched
    expect(stats.html.hits).toBe(0);
    expect(stats.html.misses).toBe(0);
    expect(stats.html.hit_rate).toBe(0);
  });

  // ---- Miss path & LRU eviction (simulated) ---------------------------
  it("miss path returns null when nothing is cached", async () => {
    const cached = await getCachedResultTiered(URL, "html", false);
    expect(cached).toBeNull();
    const stats = getCacheStats();
    expect(stats.html.misses).toBe(1);
  });

  it("a TTL'd-out entry is treated as a miss", async () => {
    await setCachedResultTiered(
      URL,
      "screenshot",
      { url: URL, statusCode: 200, screenshot: "base64" },
      1,
    );
    // Force expiry by manipulating the in-memory store directly.
    const key = `result-cache:v2:screenshot:${hashOf(URL)}`;
    const entry = store.get(key);
    expect(entry).toBeDefined();
    entry!.expiresAt = Date.now() - 1;
    const cached = await getCachedResultTiered(URL, "screenshot", false);
    expect(cached).toBeNull();
  });

  // ---- Helpers & backwards compatibility ------------------------------
  it("pickCacheTier picks screenshot > extract > html > markdown", () => {
    expect(pickCacheTier(undefined)).toBe("markdown");
    expect(pickCacheTier([])).toBe("markdown");
    expect(pickCacheTier([{ type: "markdown" }])).toBe("markdown");
    expect(pickCacheTier([{ type: "html" }])).toBe("html");
    expect(pickCacheTier([{ type: "rawHtml" }])).toBe("html");
    expect(pickCacheTier([{ type: "json" }])).toBe("extract");
    expect(pickCacheTier([{ type: "summary" }])).toBe("extract");
    expect(pickCacheTier([{ type: "extract" }])).toBe("extract");
    expect(pickCacheTier([{ type: "screenshot" }])).toBe("screenshot");
    expect(pickCacheTier([{ type: "markdown" }, { type: "screenshot" }])).toBe(
      "screenshot",
    );
  });

  it("the legacy getCachedResult / setCachedResult map to the markdown tier", async () => {
    await setCachedResult(URL, {
      url: URL,
      statusCode: 200,
      markdown: "legacy",
    });
    const cached = await getCachedResult(URL);
    expect(cached).not.toBeNull();
    expect(cached?.markdown).toBe("legacy");
    const key = `result-cache:v2:markdown:${hashOf(URL)}`;
    expect(store.has(key)).toBe(true);
  });

  it("ttlSecondsFromMaxAgeMs returns undefined for missing/zero and floors positive values", () => {
    expect(ttlSecondsFromMaxAgeMs(undefined)).toBeUndefined();
    expect(ttlSecondsFromMaxAgeMs(0)).toBeUndefined();
    expect(ttlSecondsFromMaxAgeMs(-1)).toBeUndefined();
    expect(ttlSecondsFromMaxAgeMs(1500)).toBe(1);
    expect(ttlSecondsFromMaxAgeMs(60_000)).toBe(60);
  });
});
