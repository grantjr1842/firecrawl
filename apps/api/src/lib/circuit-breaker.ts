import * as Sentry from "@sentry/node";
import { logger } from "./logger";

/**
 * QR-001(c) — opossum-style circuit breaker.
 *
 * Three states:
 *   - `closed`:    calls flow through; failures increment a rolling
 *                  failure count. When the count crosses
 *                  `errorThresholdPercentage` of `volumeThreshold`
 *                  within `rollingCountTimeout` ms, the breaker opens.
 *   - `open`:      all calls fail fast with `CircuitBreakerOpenError`
 *                  until `resetTimeout` ms have elapsed.
 *   - `half-open`: a single probe call is allowed. If it succeeds the
 *                  breaker closes; if it fails the breaker re-opens
 *                  for another `resetTimeout` ms.
 *
 * This is intentionally homegrown — `opossum` is not in
 * `apps/api/package.json`. The shape of the constructor mirrors
 * opossum's `(action, options)` API so swapping later is mechanical.
 *
 * The breaker is **stateless across processes**; each worker keeps
 * its own circuit state. Rollup metrics flow through Sentry +
 * structured logs so the on-call can still see aggregate
 * open/half-open transitions across the fleet.
 */

/** Breaker state machine. */
export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Display name used in logs / Sentry breadcrumbs. */
  name: string;
  /**
   * Minimum number of calls in the rolling window before the breaker
   * can trip (default 5).
   */
  volumeThreshold?: number;
  /**
   * Failure ratio (0..1) at which the breaker opens (default 0.5).
   */
  errorThresholdPercentage?: number;
  /**
   * Rolling-window size in ms (default 10_000).
   */
  rollingCountTimeout?: number;
  /**
   * ms to stay open before allowing a half-open probe (default 30_000).
   */
  resetTimeout?: number;
  /**
   * Number of consecutive successful probes required in `half-open`
   * before the breaker closes (default 1).
   */
  halfOpenSuccessThreshold?: number;
  /**
   * Predicate classifying an error as a failure. Default: every
   * thrown value counts. Receives the error and the call attempt
   * count within the breaker so callers can short-circuit on
   * 4xx-class errors that should never trip the breaker.
   */
  isFailure?: (error: unknown) => boolean;
  /**
   * Optional timeout in ms for the wrapped call. Calls that exceed
   * this are rejected and count as failures.
   */
  timeout?: number;
}

const DEFAULT_VOLUME_THRESHOLD = 5;
const DEFAULT_ERROR_THRESHOLD = 0.5;
const DEFAULT_ROLLING_TIMEOUT = 10_000;
const DEFAULT_RESET_TIMEOUT = 30_000;
const DEFAULT_HALF_OPEN_SUCCESS = 1;

interface RollingBucket {
  startedAt: number;
  successes: number;
  failures: number;
}

/**
 * Thrown by `fire()` when the breaker is open. Distinct from the
 * wrapped action's own errors so callers can distinguish "we never
 * tried" from "we tried and it failed".
 */
export class CircuitBreakerOpenError extends Error {
  readonly breakerName: string;
  readonly nextRetryAt: number;

  constructor(breakerName: string, nextRetryAt: number) {
    super(`Circuit breaker "${breakerName}" is open — call short-circuited`);
    this.name = "CircuitBreakerOpenError";
    this.breakerName = breakerName;
    this.nextRetryAt = nextRetryAt;
  }
}

export class CircuitBreakerTimeoutError extends Error {
  readonly breakerName: string;
  readonly timeoutMs: number;

  constructor(breakerName: string, timeoutMs: number) {
    super(`Circuit breaker "${breakerName}" timed out after ${timeoutMs}ms`);
    this.name = "CircuitBreakerTimeoutError";
    this.breakerName = breakerName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Wraps an async action with circuit-breaker semantics.
 *
 * Usage:
 *
 *   const breaker = new CircuitBreaker(
 *     async (url: string) => fetch(url).then(r => r.json()),
 *     { name: "fire-engine-search", errorThresholdPercentage: 0.5 },
 *   );
 *
 *   try {
 *     const data = await breaker.fire("https://...");
 *   } catch (err) {
 *     if (err instanceof CircuitBreakerOpenError) {
 *       // skip — circuit is open
 *     }
 *   }
 *
 * The constructor is non-throwing; the wrapped action is only
 * invoked through `.fire(...)`.
 */
export class CircuitBreaker<TArgs extends unknown[], TResult> {
  readonly name: string;
  readonly volumeThreshold: number;
  readonly errorThresholdPercentage: number;
  readonly rollingCountTimeout: number;
  readonly resetTimeout: number;
  readonly halfOpenSuccessThreshold: number;
  readonly isFailure: (error: unknown) => boolean;
  readonly timeout?: number;

  private state: CircuitState = "closed";
  private openedAt = 0;
  /** Rolling window of calls in the current bucket. */
  private bucket: RollingBucket;
  /** Half-open probe tracking — incremented on success, reset on failure. */
  private halfOpenSuccesses = 0;

  constructor(
    private readonly action: (...args: TArgs) => Promise<TResult>,
    options: CircuitBreakerOptions,
  ) {
    this.name = options.name;
    this.volumeThreshold = options.volumeThreshold ?? DEFAULT_VOLUME_THRESHOLD;
    this.errorThresholdPercentage =
      options.errorThresholdPercentage ?? DEFAULT_ERROR_THRESHOLD;
    this.rollingCountTimeout =
      options.rollingCountTimeout ?? DEFAULT_ROLLING_TIMEOUT;
    this.resetTimeout = options.resetTimeout ?? DEFAULT_RESET_TIMEOUT;
    this.halfOpenSuccessThreshold =
      options.halfOpenSuccessThreshold ?? DEFAULT_HALF_OPEN_SUCCESS;
    this.isFailure = options.isFailure ?? (() => true);
    this.timeout = options.timeout;
    this.bucket = this.newBucket();
  }

  /** Read the current state. Useful for metrics endpoints / health checks. */
  getState(): CircuitState {
    this.maybeTransitionFromOpen();
    return this.state;
  }

  /** Snapshot of the rolling-window counts. */
  getStats(): {
    state: CircuitState;
    successes: number;
    failures: number;
    total: number;
    failureRatio: number;
    openedAt: number | null;
  } {
    this.maybeTransitionFromOpen();
    const total = this.bucket.successes + this.bucket.failures;
    return {
      state: this.state,
      successes: this.bucket.successes,
      failures: this.bucket.failures,
      total,
      failureRatio: total === 0 ? 0 : this.bucket.failures / total,
      openedAt: this.state === "open" ? this.openedAt : null,
    };
  }

  /**
   * Invoke the wrapped action through the breaker. Short-circuits
   * with `CircuitBreakerOpenError` when the breaker is open.
   */
  async fire(...args: TArgs): Promise<TResult> {
    this.maybeTransitionFromOpen();

    if (this.state === "open") {
      throw new CircuitBreakerOpenError(
        this.name,
        this.openedAt + this.resetTimeout,
      );
    }

    // half-open only allows a single concurrent probe — guard with a
    // synchronous flag so a burst of fire() calls during half-open
    // serializes through one trial.
    const isProbe = this.state === "half-open";

    try {
      const result = await this.invoke(args);
      this.onSuccess(isProbe);
      return result;
    } catch (error) {
      this.onFailure(error, isProbe);
      throw error;
    }
  }

  private async invoke(args: TArgs): Promise<TResult> {
    if (this.timeout === undefined) {
      return this.action(...args);
    }

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CircuitBreakerTimeoutError(this.name, this.timeout!));
      }, this.timeout);

      this.action(...args)
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(err => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private onSuccess(wasHalfOpenProbe: boolean): void {
    this.rotateBucket();
    this.bucket.successes++;

    if (this.state === "half-open") {
      if (wasHalfOpenProbe) {
        this.halfOpenSuccesses++;
        if (this.halfOpenSuccesses >= this.halfOpenSuccessThreshold) {
          this.transition("closed", "half-open probe succeeded");
        }
      }
    }
  }

  private onFailure(error: unknown, wasHalfOpenProbe: boolean): void {
    this.rotateBucket();
    const isFailure = this.isFailure(error);
    if (!isFailure) {
      // Treat non-failure errors as successes for the rolling count.
      this.bucket.successes++;
      return;
    }
    this.bucket.failures++;

    if (this.state === "half-open") {
      this.transition("open", "half-open probe failed");
      return;
    }

    if (this.state === "closed") {
      const total = this.bucket.successes + this.bucket.failures;
      if (total >= this.volumeThreshold) {
        const ratio = this.bucket.failures / total;
        if (ratio >= this.errorThresholdPercentage) {
          this.transition(
            "open",
            `failure ratio ${ratio.toFixed(2)} exceeded threshold ${this.errorThresholdPercentage}`,
          );
        }
      }
    }
  }

  private maybeTransitionFromOpen(): void {
    if (
      this.state === "open" &&
      Date.now() - this.openedAt >= this.resetTimeout
    ) {
      this.transition("half-open", "reset timeout elapsed");
    }
  }

  private transition(next: CircuitState, reason: string): void {
    if (this.state === next) return;

    const previous = this.state;
    this.state = next;

    if (next === "open") {
      this.openedAt = Date.now();
    } else if (next === "closed") {
      this.halfOpenSuccesses = 0;
      this.bucket = this.newBucket();
    } else if (next === "half-open") {
      this.halfOpenSuccesses = 0;
    }

    const breadcrumb = {
      category: "circuit-breaker",
      message: `${this.name}: ${previous} -> ${next}`,
      level: next === "open" ? "warning" : "info",
      data: {
        breaker: this.name,
        previous,
        next,
        reason,
        openedAt: next === "open" ? this.openedAt : null,
      },
    };

    logger.info(`Circuit breaker ${this.name}: ${previous} -> ${next}`, {
      canonicalLog: "circuit-breaker/transition",
      breaker: this.name,
      previous,
      next,
      reason,
    });

    Sentry.addBreadcrumb(breadcrumb);

    if (next === "open") {
      Sentry.captureMessage(
        `Circuit breaker "${this.name}" opened: ${reason}`,
        "warning",
      );
    }
  }

  private rotateBucket(): void {
    const now = Date.now();
    if (now - this.bucket.startedAt >= this.rollingCountTimeout) {
      this.bucket = this.newBucket();
    }
  }

  private newBucket(): RollingBucket {
    return { startedAt: Date.now(), successes: 0, failures: 0 };
  }
}

/**
 * Module-level registry so callers can construct breakers by name
 * and share state across hot-reloaded modules. Useful for tests
 * that want to reset a known breaker.
 */
const registry = new Map<string, CircuitBreaker<any, any>>();

export function getCircuitBreaker<TArgs extends unknown[], TResult>(
  name: string,
): CircuitBreaker<TArgs, TResult> | undefined {
  return registry.get(name) as CircuitBreaker<TArgs, TResult> | undefined;
}

export function registerCircuitBreaker<TArgs extends unknown[], TResult>(
  breaker: CircuitBreaker<TArgs, TResult>,
): void {
  registry.set(breaker.name, breaker);
}

export function resetCircuitBreakerRegistry(): void {
  registry.clear();
}

/**
 * Convenience helper: build + register a breaker in one call.
 */
export function createCircuitBreaker<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  options: CircuitBreakerOptions,
): CircuitBreaker<TArgs, TResult> {
  const breaker = new CircuitBreaker(action, options);
  registerCircuitBreaker(breaker);
  return breaker;
}
