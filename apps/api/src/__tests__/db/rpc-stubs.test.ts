// Regression coverage for finding T3.1: every cloud-only RPC in
// apps/api/src/db/rpc.ts whose PL/pgSQL body is missing from the on-disk
// migration surface must return a safe default in self-host mode
// (USE_DB_AUTHENTICATION=false). The 0018/0019 migrations that "shipped
// the bulk of the 23 cloud RPCs" were orphaned from main before the
// parity work in 0021, so without these stubs every scrape that hit the
// index cache or the monitor store would 500 in self-host.
//
// We assert three properties per stub:
//   1. No exception is thrown when USE_DB_AUTHENTICATION is false.
//   2. The return value has the expected shape (callers destructure
//      `.rows[0].field`, so the stubs must be array-shaped).
//   3. A "void" / "Promise<void>" return is still resolved (i.e. it
//      does not stall the caller).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { config } from "../../../src/config";
import {
  agentConsumeFreeRequestIfLeft,
  billTeam6,
  changeTrackingInsertScrape,
  creditsBilledByCrawlId,
  diffGetLastScrape,
  getAgentFreeRequestsLeft,
  getZdrCleanupBatch,
  indexGetRecent5,
  insertOmceJobIfNeeded,
  monitoringClaimDueMonitors,
  queryDomainPriority,
  queryEngpickerVerdict,
  queryIndexAtDomainSplitLevel,
  queryIndexAtDomainSplitLevelOmce,
  queryIndexAtDomainSplitLevelWithMeta,
  queryIndexAtSplitLevel,
  queryIndexAtSplitLevelWithMeta,
  queryMaxAge,
  queryOmceSignatures,
  queryTopUrlsForDomain,
  updateTallyTeam,
} from "../../../src/db/rpc";

const origUseDbAuth = config.USE_DB_AUTHENTICATION;

beforeAll(() => {
  // Self-host: every stubbed RPC must return a safe default.
  (config as { USE_DB_AUTHENTICATION: boolean | undefined }).USE_DB_AUTHENTICATION = false;
});

afterAll(() => {
  (config as { USE_DB_AUTHENTICATION: boolean | undefined }).USE_DB_AUTHENTICATION = origUseDbAuth;
});

const FAKE_HASH = Buffer.from("deadbeef".repeat(4), "hex");

describe("db/rpc.ts self-host stubs (T3.1)", () => {
  it("getAgentFreeRequestsLeft returns free_requests_left=999", async () => {
    const rows = await getAgentFreeRequestsLeft("00000000-0000-0000-0000-000000000000");
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]?.free_requests_left).toBe(999);
  });

  it("agentConsumeFreeRequestIfLeft returns consumed=true", async () => {
    const rows = await agentConsumeFreeRequestIfLeft("00000000-0000-0000-0000-000000000000");
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]?.consumed).toBe(true);
  });

  it("billTeam6 returns an api_key row (empty string is fine)", async () => {
    const rows = await billTeam6({
      team_id: "00000000-0000-0000-0000-000000000000",
      subscription_id: null,
      fetch_subscription: false,
      credits: 1,
      api_key_id: null,
      is_extract: false,
    });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]?.api_key).toBe("");
  });

  it("changeTrackingInsertScrape resolves without throwing", async () => {
    await expect(
      changeTrackingInsertScrape({
        team_id: "00000000-0000-0000-0000-000000000000",
        url: "https://example.com",
        job_id: "job-1",
        change_tracking_tag: null,
        date_added: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
  });

  it("creditsBilledByCrawlId returns credits_billed=0", async () => {
    const rows = await creditsBilledByCrawlId("crawl-1");
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]?.credits_billed).toBe(0);
  });

  it("diffGetLastScrape returns an empty array (no previous scrape)", async () => {
    const rows = await diffGetLastScrape(
      "00000000-0000-0000-0000-000000000000",
      "https://example.com",
      null,
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([]);
  });

  it("getZdrCleanupBatch returns an empty array", async () => {
    const rows = await getZdrCleanupBatch(10);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([]);
  });

  it("monitoringClaimDueMonitors returns an empty array", async () => {
    const rows = await monitoringClaimDueMonitors({
      workerId: "worker-1",
      limit: 5,
      leaseSeconds: 30,
    });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([]);
  });

  it("updateTallyTeam resolves without throwing", async () => {
    await expect(
      updateTallyTeam("00000000-0000-0000-0000-000000000000"),
    ).resolves.toBeUndefined();
  });

  // Index DB stubs -------------------------------------------------------------

  it("insertOmceJobIfNeeded resolves without throwing", async () => {
    await expect(insertOmceJobIfNeeded(1, FAKE_HASH)).resolves.toBeUndefined();
  });

  it("queryIndexAtSplitLevel returns []", async () => {
    const rows = await queryIndexAtSplitLevel(1, FAKE_HASH, new Date().toISOString());
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([]);
  });

  it("queryIndexAtDomainSplitLevel returns []", async () => {
    const rows = await queryIndexAtDomainSplitLevel(1, FAKE_HASH, new Date().toISOString());
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([]);
  });

  it("queryOmceSignatures returns { signatures: [] }", async () => {
    const rows = await queryOmceSignatures(FAKE_HASH, new Date().toISOString());
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]?.signatures).toEqual([]);
  });

  it("queryEngpickerVerdict returns { verdict: 'Unknown' }", async () => {
    const rows = await queryEngpickerVerdict(FAKE_HASH);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]?.verdict).toBe("Unknown");
  });

  it("queryIndexAtSplitLevelWithMeta returns []", async () => {
    const rows = await queryIndexAtSplitLevelWithMeta(1, FAKE_HASH, new Date().toISOString());
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([]);
  });

  it("queryIndexAtDomainSplitLevelWithMeta returns []", async () => {
    const rows = await queryIndexAtDomainSplitLevelWithMeta(
      1,
      FAKE_HASH,
      new Date().toISOString(),
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([]);
  });

  it("queryDomainPriority returns []", async () => {
    const rows = await queryDomainPriority(0, 0, 10, new Date().toISOString());
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([]);
  });

  it("queryIndexAtDomainSplitLevelOmce returns []", async () => {
    const rows = await queryIndexAtDomainSplitLevelOmce<{ url: string }>(
      1,
      FAKE_HASH,
      new Date().toISOString(),
      10,
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([]);
  });

  it("queryMaxAge returns { max_age: 0 }", async () => {
    const rows = await queryMaxAge(FAKE_HASH);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]?.max_age).toBe(0);
  });

  it("indexGetRecent5 returns []", async () => {
    const rows = await indexGetRecent5({
      url_hash: FAKE_HASH,
      max_age_ms: 1000,
      is_mobile: false,
      block_ads: false,
      feature_screenshot: false,
      feature_screenshot_fullscreen: false,
      location_country: null,
      location_languages: null,
      wait_time_ms: 0,
      is_stealth: false,
      min_age_ms: null,
    });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([]);
  });

  it("queryTopUrlsForDomain returns []", async () => {
    const rows = await queryTopUrlsForDomain<{ url: string }>(FAKE_HASH, "8 days", 10);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([]);
  });
});
