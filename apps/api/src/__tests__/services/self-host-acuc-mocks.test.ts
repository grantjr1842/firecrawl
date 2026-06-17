import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";
import { RateLimiterMode, SelfHostACUC } from "../../types";

// DB-RPC-006: align the TS mock in controllers/auth.ts and the PL/pgSQL
// mock in drizzle/0021_cloud_rpcs_remaining.sql on the same 10
// rate_limit keys. A consumer that toggles USE_DB_AUTHENTICATION off
// then on at runtime would otherwise see different ACUC shapes and
// silently read `undefined` for the keys one mock omits.

const API_ROOT = join(__dirname, "..", "..");
const SQL_FILE = join(API_ROOT, "..", "drizzle", "0021_cloud_rpcs_remaining.sql");
const AUTH_TS_FILE = join(API_ROOT, "controllers", "auth.ts");

// Keys the rate-limiter middleware can be asked for, in
// RateLimiterMode enum order. Used to drive the "no undefined" check.
const ALL_RATE_LIMITER_MODES: ReadonlyArray<RateLimiterMode> = [
  RateLimiterMode.Crawl,
  RateLimiterMode.CrawlStatus,
  RateLimiterMode.Scrape,
  RateLimiterMode.ScrapeAgentPreview,
  RateLimiterMode.Preview,
  RateLimiterMode.Search,
  RateLimiterMode.Map,
  RateLimiterMode.Extract,
  RateLimiterMode.ExtractStatus,
  RateLimiterMode.ExtractAgentPreview,
];

/**
 * Parse the rate_limits jsonb_build_object literal out of every
 * auth_credit_usage_chunk_* function in the migration. The function
 * bodies all use the same `jsonb_build_object('key', 99999999, ...)`
 * shape, so a single regex captures them all. Returns a list of
 * per-function key sets.
 */
function extractSqlMockKeySets(sql: string): Array<{
  function: string;
  keys: string[];
}> {
  const out: Array<{ function: string; keys: string[] }> = [];
  const funcRe =
    /CREATE OR REPLACE FUNCTION (\w+)\([\s\S]*?LANGUAGE plpgsql[\s\S]*?\$\$([\s\S]*?)\$\$;/g;
  let match: RegExpExecArray | null;
  while ((match = funcRe.exec(sql)) !== null) {
    const fnName = match[1];
    const body = match[2];
    if (!fnName.startsWith("auth_credit_usage_chunk")) {
      continue;
    }
    // Pull the jsonb_build_object for the rate_limits argument — it
    // is the 21st positional argument to the function (see RETURNS
    // TABLE column order in the migration). We grab every
    // jsonb_build_object in the body and keep the ones whose keys
    // look like a rate_limit set.
    const objs: string[][] = [];
    const objRe = /jsonb_build_object\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g;
    let inner: RegExpExecArray | null;
    while ((inner = objRe.exec(body)) !== null) {
      const entries = inner[1];
      const keys: string[] = [];
      const keyRe = /'([a-zA-Z][a-zA-Z0-9]*)'\s*,/g;
      let km: RegExpExecArray | null;
      while ((km = keyRe.exec(entries)) !== null) {
        keys.push(km[1]);
      }
      if (keys.length >= 5) {
        objs.push(keys);
      }
    }
    // The last jsonb_build_object in the function body is the
    // rate_limits map (the earlier ones are plan_priority, flags,
    // etc.). The plan_priority object has 2 keys; flags is usually
    // NULL::jsonb not jsonb_build_object; the largest key set is
    // the rate_limits one.
    if (objs.length === 0) continue;
    const rateLimits = objs.reduce((a, b) => (b.length > a.length ? b : a));
    out.push({ function: fnName, keys: rateLimits });
  }
  return out;
}

/**
 * Pull the keys out of the mockACUC object literal in
 * controllers/auth.ts. The mock is the only place in auth.ts with
 * 10 consecutive `name: 99999999` rate-limit fields inside a
 * `rate_limits: { ... }` block.
 */
function extractTsMockKeySet(authTs: string): string[] {
  const re = /rate_limits:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  let match: RegExpExecArray | null;
  const candidates: string[][] = [];
  while ((match = re.exec(authTs)) !== null) {
    const body = match[1];
    const keyRe = /^\s*([a-zA-Z][a-zA-Z0-9]*)\s*:/gm;
    const keys: string[] = [];
    let km: RegExpExecArray | null;
    while ((km = keyRe.exec(body)) !== null) {
      keys.push(km[1]);
    }
    if (keys.length >= 5) {
      candidates.push(keys);
    }
  }
  // The mockACUC rate_limits is the one with all 10 keys (the
  // tier-resolver stub in the same file uses smaller per-tier
  // numbers and is matched by an earlier / different block — we
  // want the largest candidate, which is the bypass mock).
  if (candidates.length === 0) {
    throw new Error("could not find any rate_limits block in auth.ts");
  }
  return candidates.reduce((a, b) => (b.length > a.length ? b : a));
}

describe("self-hosted ACUC mocks (DB-RPC-006)", () => {
  const sql = readFileSync(SQL_FILE, "utf8");
  const authTs = readFileSync(AUTH_TS_FILE, "utf8");

  const sqlMocks = extractSqlMockKeySets(sql);
  const tsMockKeys = extractTsMockKeySet(authTs);

  const expectedKeys: ReadonlyArray<keyof SelfHostACUC["rate_limits"]> = [
    "crawl",
    "scrape",
    "extract",
    "search",
    "map",
    "preview",
    "crawlStatus",
    "extractStatus",
    "extractAgentPreview",
    "scrapeAgentPreview",
  ];

  it("TS mock (mockACUC in auth.ts) carries all 10 rate_limit keys", () => {
    expect(tsMockKeys.sort()).toEqual([...expectedKeys].sort());
  });

  it("every auth_credit_usage_chunk_* function in the SQL migration carries all 10 rate_limit keys", () => {
    expect(sqlMocks.length).toBeGreaterThan(0);
    for (const { function: fn, keys } of sqlMocks) {
      expect(keys.sort()).toEqual([...expectedKeys].sort());
    }
  });

  it("TS mock and SQL mock produce identical rate_limit key sets", () => {
    expect(tsMockKeys.sort()).toEqual([...expectedKeys].sort());
    for (const { keys } of sqlMocks) {
      expect(keys.sort()).toEqual(tsMockKeys.sort());
    }
  });

  it("SelfHostACUC type and the mocks agree on every key (no rename, no extra, no missing)", () => {
    const typeKeys = Object.keys({} as SelfHostACUC["rate_limits"]).sort();
    expect(typeKeys).toEqual([...expectedKeys].sort());
  });

  it("no RateLimiterMode value would read an undefined key from either mock", () => {
    // For every mode the rate-limiter can ask for, both mocks must
    // have a non-undefined numeric value. This is the property
    // DB-RPC-006 was created to enforce.
    const tsValues = new Set<number | undefined>(
      tsMockKeys.map((k) => ({} as Record<string, number>)[k]),
    );
    // tsValues above is degenerate (we only have key names from
    // source) — instead simulate the lookup by parsing the literal
    // value out of auth.ts next to each key.
    const tsValueByKey: Record<string, number | undefined> = {};
    const entryRe =
      /rate_limits:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    const m = entryRe.exec(authTs);
    expect(m).not.toBeNull();
    const entryKvRe = /([a-zA-Z][a-zA-Z0-9]*)\s*:\s*(\d+)/g;
    let kv: RegExpExecArray | null;
    while ((kv = entryKvRe.exec(m![1])) !== null) {
      tsValueByKey[kv[1]] = Number(kv[2]);
    }
    for (const mode of ALL_RATE_LIMITER_MODES) {
      expect(tsValueByKey[mode]).toBeDefined();
      expect(typeof tsValueByKey[mode]).toBe("number");
    }
    // SQL side: every key has a literal integer literal in the
    // jsonb_build_object (99999999), so the parsed key set is
    // sufficient evidence the value is defined.
    for (const { keys } of sqlMocks) {
      for (const mode of ALL_RATE_LIMITER_MODES) {
        expect(keys).toContain(mode);
      }
    }
  });
});
