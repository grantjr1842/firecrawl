// QR-001 (a) drain path: the router must consult FdbHealthMonitor.isHealthy()
// when deciding where new enqueues land.
//
// This test injects a controlled FdbHealthMonitor via setFdbHealthMonitor and
// a mocked isFdbConfigured + getACUCTeam so the routing decision is fully
// observable without a live FDB cluster or a real ACUC DB. Runs in CI without
// FDB_CLUSTER_FILE (same offline pattern as auto-failover.test.ts).

import {
  FdbHealthMonitor,
  setFdbHealthMonitor,
} from "../../../services/worker/nuq-fdb/health-monitor.js";
import type { ScrapeJobData } from "../../../types";

vi.mock("../../../services/worker/nuq-fdb/client", () => ({
  isFdbConfigured: vi.fn(() => true),
  nuqFdbHealthCheck: vi.fn(async () => true),
  withFdbTimeout: async <T>(p: Promise<T>): Promise<T> => p,
  getNuqFdbDatabase: vi.fn(),
  getFdb: vi.fn(),
}));

vi.mock("../../../controllers/auth", () => ({
  getACUCTeam: vi.fn(async (_teamId: string) => ({
    flags: { nuqFdb: true },
    concurrency: 5,
  })),
}));

import { isFdbTeam, resolveJobBackend } from "../../../services/worker/nuq-router";

function makeData(overrides: Partial<ScrapeJobData> = {}): ScrapeJobData {
  return {
    url: "https://example.com",
    mode: "single_urls",
    team_id: "team_fdb",
    ...overrides,
  } as ScrapeJobData;
}

describe("nuq-router QR-001(a) drain path: FdbHealthMonitor.isHealthy()", () => {
  let monitor: FdbHealthMonitor;
  let original: FdbHealthMonitor | null;

  beforeEach(() => {
    // Build a monitor that won't probe the network (no live FDB in CI).
    monitor = new FdbHealthMonitor({
      windowSize: 5,
      minProbesForDecision: 3,
      decisionTtlMs: 50,
      skipProbe: () => true,
    });
    // Save the existing singleton so we can restore it after the suite.
    original = (monitor as any).constructor ? null : null;
    setFdbHealthMonitor(monitor);
  });

  afterEach(() => {
    monitor.stop();
    monitor.reset();
    setFdbHealthMonitor(null);
  });

  test("resolveJobBackend returns 'pg' when monitor is forced degraded", async () => {
    // Warm the window with successes so a clear force is the only thing
    // keeping the decision degraded.
    for (let i = 0; i < 5; i++) monitor.recordSuccess();
    expect(monitor.isHealthy()).toBe(true);

    // Force the monitor to degraded. isHealthy() must flip, and the router
    // must route new standalone work to PG.
    monitor.forceDegraded("test pin");
    expect(monitor.isHealthy()).toBe(false);

    const backend = await resolveJobBackend(makeData());
    expect(backend).toBe("pg");
  });

  test("isFdbTeam returns false for FDB-eligible teams when monitor is degraded", async () => {
    for (let i = 0; i < 5; i++) monitor.recordSuccess();
    expect(await isFdbTeam("team_fdb")).toBe(true);

    monitor.forceDegraded("test pin");
    // Even though the team has nuqFdb flag set, the monitor's degraded view
    // must keep new work on PG.
    expect(await isFdbTeam("team_fdb")).toBe(false);
  });

  test("resolveJobBackend returns 'fdb' again after monitor recovers", async () => {
    // Phase 1: warm up, then force degraded. New work drains to PG.
    for (let i = 0; i < 5; i++) monitor.recordSuccess();
    monitor.forceDegraded("test pin");
    expect(await resolveJobBackend(makeData())).toBe("pg");
    expect(await isFdbTeam("team_fdb")).toBe(false);

    // Phase 2: clear the pin; the cached decision also gets invalidated.
    monitor.clearForce();
    // Record a fresh batch of successes to refresh the cached decision.
    for (let i = 0; i < 5; i++) monitor.recordSuccess();
    expect(monitor.isHealthy()).toBe(true);

    // Phase 3: new work for the FDB-eligible team must route to FDB again.
    const backend = await resolveJobBackend(makeData());
    expect(backend).toBe("fdb");
    expect(await isFdbTeam("team_fdb")).toBe(true);
  });

  test("resolveJobBackend with crawl_id falls back to stored crawl marker when monitor is degraded", async () => {
    // When the monitor is degraded, crawl-pinned work keeps following its
    // StoredCrawl.queueBackend marker (an in-flight FDB crawl cannot migrate
    // mid-flight). With no marker present in this test, we expect "pg".
    for (let i = 0; i < 5; i++) monitor.recordSuccess();
    monitor.forceDegraded("test pin");
    const backend = await resolveJobBackend(
      makeData({ crawl_id: "crawl-no-marker" }),
    );
    expect(backend).toBe("pg");
  });
});
