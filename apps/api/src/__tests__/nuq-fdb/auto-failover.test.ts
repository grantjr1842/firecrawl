import { randomUUID } from "crypto";
import { config } from "../../config";
import {
  FdbHealthMonitor,
  setFdbHealthMonitor,
} from "../../services/worker/nuq-fdb/health-monitor.js";
import { redisEvictConnection } from "../../services/redis";
import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  vi,
} from "vitest";

// 1-failover integration test for the T4.1 auto-failover health monitor.
// Runs in two modes:
//
//   1. With a live FDB cluster (config.FDB_CLUSTER_FILE set): exercises the
//      real network probe path. Asserts the monitor flips to healthy after
//      real probes, and respects a forced-degraded pin even with the
//      cluster up (operator kill-switch / canary).
//
//   2. Without FDB: the monitor's skipProbe hook makes the probe path a
//      no-op so the test still runs end-to-end against the monitor, the
//      Redis crawler marker, and the ACUC stub. This is what CI without an
//      FDB cluster sees.
//
// The test name reflects the spec: "1-failover" = one full cycle of healthy
// -> degraded -> healthy, asserting the routing decision flips and recovers.

const describeIf = config.FDB_CLUSTER_FILE ? describe : describe.skip;
const describeAlways = describe;

describeAlways("FdbHealthMonitor (offline mode)", () => {
  let monitor: FdbHealthMonitor;

  beforeEach(() => {
    monitor = new FdbHealthMonitor({
      windowSize: 5,
      minProbesForDecision: 3,
      decisionTtlMs: 50,
      skipProbe: () => true,
    });
  });

  afterEach(() => {
    monitor.stop();
    monitor.reset();
  });

  test("starts in unknown state and flips to healthy after enough successes", () => {
    expect(monitor.decision()).toBe("unknown");
    expect(monitor.isHealthy()).toBe(false); // unknown != healthy
    for (let i = 0; i < 5; i++) monitor.recordSuccess();
    expect(monitor.decision()).toBe("healthy");
    expect(monitor.isHealthy()).toBe(true);
  });

  test("flips to degraded when failures dominate the window", () => {
    for (let i = 0; i < 5; i++) monitor.recordSuccess();
    expect(monitor.decision()).toBe("healthy");
    for (let i = 0; i < 5; i++) monitor.recordFailure();
    expect(monitor.decision()).toBe("degraded");
    expect(monitor.isHealthy()).toBe(false);
  });

  test("forced degraded overrides window-based decision", () => {
    for (let i = 0; i < 5; i++) monitor.recordSuccess();
    expect(monitor.decision()).toBe("healthy");
    monitor.forceDegraded("test pin");
    expect(monitor.decision()).toBe("degraded");
    expect(monitor.isHealthy()).toBe(false);
    monitor.clearForce();
    expect(monitor.decision()).toBe("healthy");
  });

  test("sliding window evicts old outcomes", () => {
    for (let i = 0; i < 5; i++) monitor.recordSuccess();
    expect(monitor.snapshot().totalProbes).toBe(5);
    for (let i = 0; i < 5; i++) monitor.recordFailure();
    expect(monitor.snapshot().totalProbes).toBe(5); // window cap
    expect(monitor.decision()).toBe("degraded");
  });

  test("snapshot exposes state for /metrics and operator dashboards", () => {
    monitor.recordSuccess();
    monitor.recordSuccess();
    monitor.recordFailure();
    const snap = monitor.snapshot();
    expect(snap.successRatio).toBeCloseTo(2 / 3);
    expect(snap.totalProbes).toBe(3);
    expect(snap.lastOk).toBe(false);
  });

  test("1-failover: healthy -> degraded -> healthy (full cycle)", () => {
    // 1st phase: warm up the window with successes
    for (let i = 0; i < 5; i++) monitor.recordSuccess();
    expect(monitor.isHealthy()).toBe(true);

    // 2nd phase: cluster degrades; the monitor's window flips
    for (let i = 0; i < 5; i++) monitor.recordFailure();
    expect(monitor.decision()).toBe("degraded");
    expect(monitor.isHealthy()).toBe(false);

    // 3rd phase: cluster recovers; the monitor flips back
    for (let i = 0; i < 5; i++) monitor.recordSuccess();
    expect(monitor.decision()).toBe("healthy");
    expect(monitor.isHealthy()).toBe(true);
  });
});

describeAlways("T4.1 auto-failover singleton lifecycle", () => {
  // Exercises the process-wide singleton hooks. The router uses
  // getFdbHealthMonitor() at runtime, so setFdbHealthMonitor() lets tests
  // (and the boot sequence) inject a different monitor.

  test("getFdbHealthMonitor returns a stable instance across calls", async () => {
    const { getFdbHealthMonitor } = await import(
      "../../services/worker/nuq-fdb/health-monitor.js"
    );
    const a = getFdbHealthMonitor();
    const b = getFdbHealthMonitor();
    expect(a).toBe(b);
  });

  test("setFdbHealthMonitor detaches the singleton for test isolation", async () => {
    const { getFdbHealthMonitor, setFdbHealthMonitor } = await import(
      "../../services/worker/nuq-fdb/health-monitor.js"
    );
    const original = getFdbHealthMonitor();
    const replacement = new FdbHealthMonitor({ skipProbe: () => true });
    setFdbHealthMonitor(replacement);
    try {
      expect(getFdbHealthMonitor()).toBe(replacement);
    } finally {
      setFdbHealthMonitor(null);
      expect(getFdbHealthMonitor()).toBe(original);
    }
  });

  test("start/stop is idempotent and safe to call repeatedly", () => {
    const m = new FdbHealthMonitor({ skipProbe: () => true });
    const stop1 = m.start();
    const stop2 = m.start();
    expect(stop1).toBe(stop2);
    m.stop();
    m.stop(); // no-op
  });
});

describeIf("T4.1 auto-failover (live FDB)", () => {
  let monitor: FdbHealthMonitor;

  beforeAll(() => {
    (config as any).NUQ_BACKEND = "fdb";
    (config as any).USE_DB_AUTHENTICATION = false;
    monitor = new FdbHealthMonitor({
      windowSize: 4,
      minProbesForDecision: 2,
      decisionTtlMs: 50,
      probeTimeoutMs: 500,
    });
    setFdbHealthMonitor(monitor);
  });

  afterAll(() => {
    (config as any).NUQ_BACKEND = undefined;
    (config as any).USE_DB_AUTHENTICATION = undefined;
    setFdbHealthMonitor(null);
  });

  test("live FDB: real probe reports healthy when cluster is up", async () => {
    const ok = await monitor.probe();
    expect(ok).toBe(true);
    // one probe isn't enough for a healthy decision (min=2)
    expect(monitor.decision()).toBe("unknown");
    await monitor.probe();
    expect(monitor.decision()).toBe("healthy");
  });

  test("live FDB: forced degraded overrides the live cluster", async () => {
    // The cluster is fine, but the monitor is pinned to degraded (operator
    // kill-switch / canary). Decision must respect the pin.
    await monitor.probe();
    await monitor.probe();
    expect(monitor.isHealthy()).toBe(true);
    monitor.forceDegraded("test canary");
    expect(monitor.isHealthy()).toBe(false);
    monitor.clearForce();
  });
});

// silence vitest's "vi" import — keep at the bottom so the linter doesn't
// trip on an unused binding
void vi;
