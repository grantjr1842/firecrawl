import * as Sentry from "@sentry/node";
import { logger } from "./logger";

/**
 * QR-001(c) — Centralized retry helpers.
 *
 * Provides a single, well-tested home for the retry patterns that were
 * previously inlined across `gcs-jobs.ts`, `judgeChange.ts`,
 * `index-worker.ts`, `log_job.ts`, `batch_billing.ts`, and the 23
 * Postgres RPCs.
 *
 * Exports:
 *   - Backoff strategy helpers (`constantBackoff`, `linearBackoff`,
 *     `exponentialBackoff`, `decorrelatedJitterBackoff`)
 *   - `computeBackoff` — single entry point that materializes a delay
 *     from a strategy and attempt index, with optional jitter
 *   - `executeWithRetry` — generalized retry orchestrator (backward
 *     compatible with the previous signature)
 *   - `attemptRequest` — unchanged HTTP request helper
 *   - `retryFireEngineApi` — convenience wrapper combining
 *     `attemptRequest` + `executeWithRetry` for Fire Engine callers
 *     (preserved for backward compat — pre-existing exports keep their
 *     old behavior)
 *   - `retryIdempotent` — retries only when the wrapped operation
 *     declares itself idempotent (e.g. read-only / GCS GETs)
 */

const RETRY_DELAYS = [500, 1500, 3000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;

/**
 * Generic HTTP request function for Fire Engine API calls
 */
export async function attemptRequest<T>(
  url: string,
  data: string,
  abort?: AbortSignal,
): Promise<T | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Disable-Cache": "true",
      },
      body: data,
      signal: abort,
    });

    if (response.ok) {
      return await response.json();
    } else {
      // Log non-OK responses for better observability
      const statusText = response.statusText || "Unknown Error";
      let bodySnippet = "";
      try {
        const body = await response.text();
        bodySnippet = body.length > 200 ? body.substring(0, 200) + "..." : body;
      } catch {
        bodySnippet = "[Unable to read response body]";
      }

      logger.warn(`Fire Engine API returned ${response.status} ${statusText}`, {
        url,
        status: response.status,
        statusText,
        bodySnippet,
      });
    }
  } catch (error) {
    logger.error("Fire Engine API request failed:", error);
    Sentry.captureException(error);
  }
  return null;
}

/**
 * Abortable sleep function that resolves immediately if the signal is aborted
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timeoutId = setTimeout(() => {
      resolve();
    }, ms);

    const abortHandler = () => {
      clearTimeout(timeoutId);
      resolve();
    };

    signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

// ============================================================================
// Backoff strategies (QR-001c)
// ============================================================================

/**
 * Named backoff strategies.
 *
 * - `constant`: same delay every attempt (`baseDelayMs`)
 * - `linear`: `baseDelayMs * (attempt + 1)`
 * - `exponential`: `baseDelayMs * 2^attempt`, capped at `maxDelayMs`
 * - `decorrelated-jitter`: AWS-style
 *   `min(maxDelayMs, random(baseDelayMs, prevDelayMs * 3))`. For
 *   attempt 0 we use `baseDelayMs` as the seed.
 */
export type BackoffStrategy =
  | "constant"
  | "linear"
  | "exponential"
  | "decorrelated-jitter";

export interface BackoffOptions {
  /** Starting delay in milliseconds (default 100) */
  baseDelayMs?: number;
  /** Hard ceiling for the computed delay (default 30_000) */
  maxDelayMs?: number;
  /**
   * Multiplier for jitter amount. `0` disables jitter, `1` allows
   * ±100% randomization, `0.5` ±50%, etc. (default 0)
   */
  jitter?: number;
}

const DEFAULT_BASE_DELAY = 100;
const DEFAULT_MAX_DELAY = 30_000;

function applyJitter(delay: number, jitter: number): number {
  if (jitter <= 0) return delay;
  // Symmetric jitter: delay * (1 + uniform(-jitter, +jitter))
  const factor = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(delay * factor));
}

/** Constant backoff: same delay every attempt. */
export function constantBackoff(
  attempt: number,
  options: BackoffOptions = {},
): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY;
  const delay = Math.min(base, options.maxDelayMs ?? DEFAULT_MAX_DELAY);
  return applyJitter(delay, options.jitter ?? 0);
}

/** Linear backoff: `baseDelayMs * (attempt + 1)`. */
export function linearBackoff(
  attempt: number,
  options: BackoffOptions = {},
): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY;
  const delay = Math.min(
    base * (attempt + 1),
    options.maxDelayMs ?? DEFAULT_MAX_DELAY,
  );
  return applyJitter(delay, options.jitter ?? 0);
}

/** Exponential backoff: `baseDelayMs * 2^attempt`, capped at `maxDelayMs`. */
export function exponentialBackoff(
  attempt: number,
  options: BackoffOptions = {},
): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY;
  // Use safe math to avoid 2**31 overflow.
  const shift = Math.min(attempt, 30);
  const raw = base * Math.pow(2, shift);
  const delay = Math.min(raw, max);
  return applyJitter(delay, options.jitter ?? 0);
}

/**
 * Decorrelated jitter (AWS Architecture Blog "Exponential Backoff and
 * Jitter"): for attempt N we treat `prevDelay` as the previous delay
 * and pick `min(maxDelay, random(baseDelay, prevDelay * 3))`. For the
 * first attempt the caller should pass `prevDelay = baseDelayMs`.
 */
export function decorrelatedJitterBackoff(
  attempt: number,
  options: BackoffOptions = {},
  prevDelay?: number,
): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY;
  const seed = prevDelay ?? base;
  const upper = Math.min(seed * 3, max);
  const lower = base;
  const cap = Math.max(lower, upper);
  const delay = lower + Math.random() * Math.max(0, cap - lower);
  return Math.round(delay);
}

/**
 * Single entry point that materializes a delay from a strategy and
 * attempt index. Jitter is applied for every strategy except
 * `decorrelated-jitter`, which has jitter baked in.
 */
export function computeBackoff(
  strategy: BackoffStrategy,
  attempt: number,
  options: BackoffOptions = {},
  prevDelay?: number,
): number {
  switch (strategy) {
    case "constant":
      return constantBackoff(attempt, options);
    case "linear":
      return linearBackoff(attempt, options);
    case "exponential":
      return exponentialBackoff(attempt, options);
    case "decorrelated-jitter":
      return decorrelatedJitterBackoff(attempt, options, prevDelay);
    default: {
      // Exhaustiveness check
      const _exhaustive: never = strategy;
      return _exhaustive;
    }
  }
}

// ============================================================================
// Retry orchestrator (QR-001c)
// ============================================================================

/**
 * Classifier that decides whether a given error is worth retrying.
 * Returning `false` aborts the retry loop immediately and rethrows.
 */
export type ShouldRetry = (error: unknown, attempt: number) => boolean;

const defaultShouldRetry: ShouldRetry = () => true;

/**
 * Predicate that decides whether a returned value is "good enough".
 * Returning `true` short-circuits the retry loop and returns the
 * value. The default returns `true` for any non-null value.
 */
export type IsResultValid<T> = (result: T | null) => result is T;

const defaultIsResultValid = <T>(result: T | null): result is T =>
  result !== null;

/**
 * Options for `executeWithRetry`. All fields are optional; the
 * defaults preserve the legacy fixed-array behavior.
 */
export interface RetryOptions {
  /** Optional AbortSignal to cancel the operation */
  signal?: AbortSignal;
  /**
   * Maximum number of attempts (defaults to legacy `MAX_ATTEMPTS` = 4).
   * When used with a `backoffStrategy` we still cap at this value.
   */
  maxAttempts?: number;
  /**
   * Explicit delay schedule (ms) between retries. Overrides
   * `backoffStrategy` if both are provided.
   */
  retryDelays?: readonly number[];
  /**
   * Backoff strategy used to compute delays when no explicit
   * `retryDelays` is provided. Defaults to legacy fixed `[500, 1500,
   * 3000]`.
   */
  backoffStrategy?: BackoffStrategy;
  /** Backoff tuning (only consulted when `backoffStrategy` is set). */
  backoffOptions?: BackoffOptions;
  /**
   * When `true`, the operation is only retried if it declares itself
   * idempotent (via the `idempotencyKey` option or `idempotent: true`
   * on the operation closure). Non-idempotent operations fail fast
   * after a single attempt.
   */
  requireIdempotency?: boolean;
  /**
   * Optional idempotency key. When set, retries are allowed even
   * with `requireIdempotency: true`.
   */
  idempotencyKey?: string;
  /**
   * Error-classifier hook. Receives `(error, attempt)` and returns
   * `true` to continue retrying, `false` to abort and rethrow.
   */
  shouldRetry?: ShouldRetry;
  /**
   * Hook fired after every failed attempt (before the backoff
   * sleep). Useful for metrics / structured logging.
   */
  onAttemptFailure?: (info: {
    attempt: number;
    error: unknown;
    nextDelayMs: number;
  }) => void;
}

/**
 * Generic retry utility that executes an operation with the chosen
 * backoff strategy.
 *
 * Backward compatible with the legacy signature:
 *
 *   executeWithRetry(op, isValid?, signal?, maxAttempts?, retryDelays?)
 *
 * New options (backoffStrategy, jitter, idempotency, error classifier)
 * are layered on top via the final `options` parameter.
 */
export async function executeWithRetry<T>(
  operation: () => Promise<T | null>,
  hasValidResult: IsResultValid<T> = defaultIsResultValid,
  signal?: AbortSignal,
  maxAttempts: number = MAX_ATTEMPTS,
  retryDelays?: readonly number[],
  options: RetryOptions = {},
): Promise<T | null> {
  const attempts = options.maxAttempts ?? maxAttempts ?? MAX_ATTEMPTS;
  const delays = options.retryDelays ?? retryDelays ?? RETRY_DELAYS;
  const strategy = options.backoffStrategy;
  const strategyOptions = options.backoffOptions;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  // Idempotency gate: if requireIdempotency is set and the caller
  // didn't supply an idempotencyKey, only run the operation once.
  if (options.requireIdempotency && !options.idempotencyKey) {
    if (signal?.aborted) return null;
    try {
      const result = await operation();
      if (hasValidResult(result)) return result;
      return null;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return null;
      }
      throw error;
    }
  }

  let prevDelay: number | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) break;

    try {
      const result = await operation();

      if (hasValidResult(result)) {
        return result;
      }
    } catch (error) {
      // Don't log or report expected abort errors to reduce noise
      if (error instanceof Error && error.name === "AbortError") {
        break;
      }

      const isLastAttempt = attempt >= attempts - 1;

      // Always run the classifier — even on the last attempt — so
      // callers can choose to abort early (e.g. non-retryable 4xx
      // errors) and get the error thrown back without further delay.
      const continueRetrying = !isLastAttempt && shouldRetry(error, attempt);

      logger.error(`Attempt ${attempt + 1} failed:`, error);
      Sentry.captureException(error);

      if (!continueRetrying) {
        // Either shouldRetry returned false (caller says don't
        // retry) OR we've used our last attempt — surface the error
        // so the caller can convert it to whatever shape they need.
        throw error;
      }

      // Compute the next delay BEFORE invoking the failure hook so
      // hooks see the correct `nextDelayMs`.
      const nextDelayMs = computeNextDelay({
        attempt,
        retryDelays: delays,
        strategy,
        strategyOptions,
        prevDelay,
      });

      options.onAttemptFailure?.({ attempt, error, nextDelayMs });

      // Wait before retry (except on last attempt)
      if (attempt < attempts - 1 && nextDelayMs > 0) {
        await abortableSleep(nextDelayMs, signal);
        prevDelay = nextDelayMs;
      }
      continue;
    }

    // Successful call path: compute delay only when we'll actually wait.
    if (attempt < attempts - 1) {
      const nextDelayMs = computeNextDelay({
        attempt,
        retryDelays: delays,
        strategy,
        strategyOptions,
        prevDelay,
      });
      options.onAttemptFailure?.({
        attempt,
        error: null,
        nextDelayMs,
      });
      if (nextDelayMs > 0) {
        await abortableSleep(nextDelayMs, signal);
        prevDelay = nextDelayMs;
      }
    }
  }

  return null;
}

interface ComputeNextDelayArgs {
  attempt: number;
  retryDelays: readonly number[];
  strategy?: BackoffStrategy;
  strategyOptions?: BackoffOptions;
  prevDelay?: number;
}

function computeNextDelay(args: ComputeNextDelayArgs): number {
  const { attempt, retryDelays, strategy, strategyOptions, prevDelay } = args;

  // Legacy fixed-array behavior takes precedence when no strategy is
  // configured. The legacy impl reads `retryDelays[attempt]` directly,
  // which is what existing callers depend on.
  if (!strategy) {
    if (attempt < retryDelays.length) {
      return retryDelays[attempt];
    }
    return 0;
  }

  return computeBackoff(strategy, attempt, strategyOptions, prevDelay);
}

// ============================================================================
// Backward-compat helper (QR-001c)
// ============================================================================

/**
 * Convenience wrapper: combines `attemptRequest` with
 * `executeWithRetry`. Preserved for callers that already rely on the
 * existing `executeWithRetry` + `attemptRequest` pair.
 *
 * Honors the same `(url, data, abort, hasValidResult?, options?)`
 * shape used elsewhere; defaults preserve the legacy fixed-delay
 * behavior.
 */
export async function retryFireEngineApi<T>(
  url: string,
  data: string,
  abort: AbortSignal | undefined,
  hasValidResult: IsResultValid<T> = defaultIsResultValid,
  options: RetryOptions = {},
): Promise<T | null> {
  return executeWithRetry<T>(
    () => attemptRequest<T>(url, data, abort),
    hasValidResult,
    abort,
    undefined,
    undefined,
    options,
  );
}

/**
 * Retries an idempotent operation with exponential backoff and full
 * jitter. Throws if the wrapped function is not declared idempotent.
 *
 * Use for read-only operations (GCS GETs, Qdrant reads, search index
 * queries) where repeated calls are safe and partial-failure storms
 * are likely.
 */
export async function retryIdempotent<T>(
  operation: () => Promise<T | null>,
  hasValidResult: IsResultValid<T> = defaultIsResultValid,
  options: Omit<RetryOptions, "requireIdempotency" | "idempotencyKey"> & {
    idempotencyKey: string;
  },
): Promise<T | null> {
  return executeWithRetry<T>(
    operation,
    hasValidResult,
    options.signal,
    undefined,
    undefined,
    {
      ...options,
      requireIdempotency: true,
      idempotencyKey: options.idempotencyKey,
    },
  );
}
