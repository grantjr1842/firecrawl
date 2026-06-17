import { logger as _logger } from "../../../lib/logger";
import { withFdbTimeout } from "./client.js";

// FdbHealthMonitor — process-wide health tracker for the FDB queue backend.
//
// The per-operation `nuqFdbHealthCheck` is a one-shot probe. The auto-failover
// path needs a *decision*: "is FDB healthy enough to take NEW work right now,
// or should new enqueues + takes route to PG/BullMQ?". This module gives the
// router that decision by sliding the per-op results into a window.
//
// The monitor is intentionally read-mostly:
//  - `recordSuccess()` and `recordFailure()` are called on every probe.
//  - `isHealthy()` returns the cached decision with a 2s TTL.
//  - `forceDegraded()` lets tests / operators pin a degraded view without
//    touching the cluster (the next fresh probe clears the pin).
//  - `start()` runs a background probe every 10s; the test harness can use
//    `stop()` to clean up.
//
// This is the foundation for the full T4.1 auto-failover; the per-op
// `optionalFdb` path stays as-is (it has its own per-call timeout). New work
// routing (resolveJobBackend, isFdbTeam) will consult `isHealthy()` so a
// degraded FDB cluster drains naturally to PG/BullMQ.

export type FdbHealthDecision = "healthy" | "degraded" | "unknown";

export interface FdbHealthSnapshot {
  decision: FdbHealthDecision;
  // ratio of successful probes in the current window (0..1); undefined if no probes
  successRatio: number | undefined;
  totalProbes: number;
  // last probe wall-clock timestamp
  lastCheckedAt: number | null;
  // last probe outcome
  lastOk: boolean | null;
  // reason for the current decision (probe count, forced, etc.)
  reason: string;
}

const DEFAULT_WINDOW = 20;
const DEFAULT_PROBE_TIMEOUT_MS = 1000;
const DEFAULT_DECISION_TTL_MS = 2000;
const DEFAULT_BACKGROUND_PROBE_MS = 10_000;
const DEGRADED_SUCCESS_RATIO = 0.5;
const DEGRADED_MIN_PROBES = 3;

export interface FdbHealthMonitorConfig {
  windowSize?: number;
  probeTimeoutMs?: number;
  decisionTtlMs?: number;
  backgroundProbeMs?: number;
  successRatioThreshold?: number;
  minProbesForDecision?: number;
  // Hook for tests: when true, probe() returns true without touching FDB.
  skipProbe?: () => boolean;
}

export class FdbHealthMonitor {
  private readonly windowSize: number;
  private readonly probeTimeoutMs: number;
  private readonly decisionTtlMs: number;
  private readonly backgroundProbeMs: number;
  private readonly successRatioThreshold: number;
  private readonly minProbesForDecision: number;
  private readonly skipProbe?: () => boolean;

  // ring buffer of recent probe outcomes
  private readonly outcomes: boolean[] = [];
  // running counters — kept consistent with `outcomes`
  private successCount = 0;
  private failureCount = 0;
  private lastCheckedAt: number | null = null;
  private lastOk: boolean | null = null;
  private lastDecision: FdbHealthDecision = "unknown";
  private lastDecisionAt = 0;
  private lastReason = "no probes yet";
  // test / operator override — when non-null, isHealthy returns this decision
  private forcedDecision: FdbHealthDecision | null = null;
  private forcedAt: number | null = null;
  // background probe handle
  private timer: NodeJS.Timeout | null = null;

  constructor(config: FdbHealthMonitorConfig = {}) {
    this.windowSize = config.windowSize ?? DEFAULT_WINDOW;
    this.probeTimeoutMs = config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.decisionTtlMs = config.decisionTtlMs ?? DEFAULT_DECISION_TTL_MS;
    this.backgroundProbeMs =
      config.backgroundProbeMs ?? DEFAULT_BACKGROUND_PROBE_MS;
    this.successRatioThreshold =
      config.successRatioThreshold ?? DEGRADED_SUCCESS_RATIO;
    this.minProbesForDecision =
      config.minProbesForDecision ?? DEGRADED_MIN_PROBES;
    this.skipProbe = config.skipProbe;
  }

  /**
   * Record a successful FDB health probe. Called by `optionalFdb` and by the
   * background prober.
   */
  recordSuccess(): void {
    this.record(true);
  }

  /**
   * Record a failed FDB health probe. Called by `optionalFdb` and by the
   * background prober.
   */
  recordFailure(): void {
    this.record(false);
  }

  private record(ok: boolean): void {
    this.outcomes.push(ok);
    this.lastOk = ok;
    this.lastCheckedAt = Date.now();
    if (ok) this.successCount += 1;
    else this.failureCount += 1;
    if (this.outcomes.length > this.windowSize) {
      const dropped = this.outcomes.shift()!;
      if (dropped) this.successCount -= 1;
      else this.failureCount -= 1;
    }
    // invalidate the cached decision; it will be recomputed on next isHealthy
    this.lastDecisionAt = 0;
  }

  /**
   * Get the current health decision. The result is cached for `decisionTtlMs`
   * so a hot-path router check costs essentially nothing. If a forced decision
   * is set, it overrides everything except a forced decision that has aged out.
   */
  isHealthy(): boolean {
    return this.decision() === "healthy";
  }

  decision(): FdbHealthDecision {
    if (this.forcedDecision !== null) {
      // forced decisions expire after 5 minutes so a stuck pin can't
      // permanently mask a real outage
      if (this.forcedAt !== null && Date.now() - this.forcedAt > 5 * 60_000) {
        this.forcedDecision = null;
        this.forcedAt = null;
      } else {
        return this.forcedDecision;
      }
    }
    const now = Date.now();
    if (now - this.lastDecisionAt < this.decisionTtlMs) {
      return this.lastDecision;
    }
    const total = this.successCount + this.failureCount;
    if (total < this.minProbesForDecision) {
      this.lastDecision = "unknown";
      this.lastReason = `insufficient probes (${total}/${this.minProbesForDecision})`;
    } else {
      const ratio = this.successCount / total;
      if (ratio < this.successRatioThreshold) {
        this.lastDecision = "degraded";
        this.lastReason = `success ratio ${ratio.toFixed(2)} below ${this.successRatioThreshold} (${this.successCount}/${total})`;
      } else {
        this.lastDecision = "healthy";
        this.lastReason = `success ratio ${ratio.toFixed(2)} of ${this.successCount}/${total}`;
      }
    }
    this.lastDecisionAt = now;
    return this.lastDecision;
  }

  /**
   * Force the monitor into a degraded view. Used by tests and by an operator
   * kill-switch; a fresh probe from the background loop will override a force
   * within `backgroundProbeMs`.
   */
  forceDegraded(reason: string = "forced degraded"): void {
    this.forcedDecision = "degraded";
    this.forcedAt = Date.now();
    this.lastReason = reason;
    this.lastDecisionAt = Date.now();
  }

  clearForce(): void {
    this.forcedDecision = null;
    this.forcedAt = null;
    this.lastDecisionAt = 0;
  }

  /**
   * Snapshot of the current state — useful for /metrics and for tests
   * asserting on the failover decision.
   */
  snapshot(): FdbHealthSnapshot {
    const total = this.successCount + this.failureCount;
    return {
      decision: this.decision(),
      successRatio: total > 0 ? this.successCount / total : undefined,
      totalProbes: total,
      lastCheckedAt: this.lastCheckedAt,
      lastOk: this.lastOk,
      reason: this.lastReason,
    };
  }

  /**
   * Run a single health probe against FDB. Used by the optionalFdb path and
   * by the background prober. Catches all errors so it never throws.
   */
  async probe(): Promise<boolean> {
    if (this.skipProbe?.()) {
      // test environment with no live FDB; treat as healthy so the router
      // behaves as it does for PG-only deploys
      this.recordSuccess();
      return true;
    }
    try {
      const ok = await this.networkProbe();
      if (ok) this.recordSuccess();
      else this.recordFailure();
      return ok;
    } catch (error) {
      this.recordFailure();
      _logger.warn("FDB health monitor probe threw", { error });
      return false;
    }
  }

  // A direct read-version probe — bypasses nuqFdbHealthCheck's 5s cache so the
  // monitor sees fresh results on every tick.
  private async networkProbe(): Promise<boolean> {
    try {
      // lazy import to keep the module load order simple
      const { getNuqFdbDatabase } = await import("./client.js");
      await withFdbTimeout(
        getNuqFdbDatabase().doTn(async (tn: any) => {
          await tn.getReadVersion();
        }),
        this.probeTimeoutMs,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start the background probe loop. Idempotent; calling start() twice does
   * not double-schedule. Returns a stop function.
   */
  start(): () => void {
    if (this.timer) return this.stop;
    const tick = async () => {
      try {
        await this.probe();
      } catch (error) {
        _logger.warn("FDB health monitor background probe failed", { error });
      }
    };
    // fire one probe immediately so callers don't have to wait
    void tick();
    this.timer = setInterval(tick, this.backgroundProbeMs);
    if (this.timer.unref) this.timer.unref();
    return this.stop;
  }

  stop = (): void => {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  };

  // Test helper — reset all state.
  reset(): void {
    this.outcomes.length = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.lastCheckedAt = null;
    this.lastOk = null;
    this.lastDecision = "unknown";
    this.lastDecisionAt = 0;
    this.lastReason = "no probes yet";
    this.forcedDecision = null;
    this.forcedAt = null;
  }
}

// Process-wide singleton. Lazy: tests can call `setFdbHealthMonitor(null)` to
// detach before constructing their own.
let singleton: FdbHealthMonitor | null = null;
let started = false;

export function getFdbHealthMonitor(): FdbHealthMonitor {
  if (singleton === null) singleton = new FdbHealthMonitor();
  return singleton;
}

export function setFdbHealthMonitor(monitor: FdbHealthMonitor | null): void {
  if (started && singleton) singleton.stop();
  singleton = monitor;
  started = false;
}

export function startFdbHealthMonitor(): void {
  if (started) return;
  const m = getFdbHealthMonitor();
  m.start();
  started = true;
}

export function stopFdbHealthMonitor(): void {
  if (!started) return;
  if (singleton) singleton.stop();
  started = false;
}
