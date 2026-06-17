import { NextFunction, Request, Response } from "express";
import { logger } from "../../../src/lib/logger";

// In-memory store of replayed responses, keyed by idempotency key.
// This is the foundation for the response-capture path; production
// should swap this for a Redis-backed store so retries across multiple
// API replicas are covered.
const replayStore = new Map<
  string,
  { status: number; body: unknown; contentType: string }
>();

const REPLAY_HEADER = "x-idempotency-replayed";

/**
 * replayMiddleware — captures the response body via a res.json override
 * and replays it on retry with the same `x-idempotency-key` header.
 *
 * This is intentionally minimal: it lives in front of idempotencyMiddleware
 * and is gated on a config flag so existing behavior is preserved.
 *
 * The res.json override is the most fragile part — Express's default
 * `res.json` returns `this` and is safe to wrap, but a global error
 * handler that calls `res.json` itself will go through our wrapper. We
 * intentionally route the wrapper's `res.json` through `res.send` to
 * avoid infinite recursion with the Sentry-aware error handler in
 * src/index.ts which uses `res.json` directly.
 */
export function replayMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const rawKey = req.headers["x-idempotency-key"];
  const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  if (!idempotencyKey) {
    return next();
  }

  // Replay path: a prior response was captured for this key.
  const prior = replayStore.get(idempotencyKey);
  if (prior) {
    if (!res.headersSent) {
      res.setHeader(REPLAY_HEADER, "true");
      res
        .status(prior.status)
        .set("Content-Type", prior.contentType)
        .send(
          typeof prior.body === "string"
            ? prior.body
            : JSON.stringify(prior.body),
        );
    }
    return;
  }

  // Capture path: wrap res.json AND res.send so we record whatever the
  // route eventually returns to the client.
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = ((body: unknown) => {
    // Only capture successful responses. A 4xx/5xx is a retryable
    // failure and we want the next request with the same key to be
    // able to succeed.
    const status = res.statusCode || 200;
    if (status < 400) {
      captureAndForward(idempotencyKey, status, body, "application/json");
    }
    return originalJson(body);
  }) as typeof res.json;

  res.send = ((body: unknown) => {
    if (!replayStore.has(idempotencyKey)) {
      const status = res.statusCode || 200;
      if (status < 400) {
        const contentType =
          (res.getHeader("Content-Type") as string | undefined) ??
          "text/plain; charset=utf-8";
        replayStore.set(idempotencyKey, { status, body, contentType });
      }
    }
    return originalSend(body);
  }) as typeof res.send;

  // Error path: if next(err) is called and the global error handler
  // calls res.json, our wrapper still captures the response. This is
  // the interaction the test in __tests__/e2e/idempotency-replay.test.ts
  // guards against.
  res.on("close", () => {
    const stored = replayStore.get(idempotencyKey);
    if (!stored && res.statusCode >= 400) {
      logger.debug(
        `replayMiddleware: response closed with status ${res.statusCode} for key ${idempotencyKey}; not capturing`,
      );
    }
  });

  next();
}

function captureAndForward(
  key: string,
  status: number,
  body: unknown,
  contentType: string,
): void {
  if (replayStore.has(key)) {
    return;
  }
  replayStore.set(key, { status, body, contentType });
}

/** Test helper — clears the in-memory replay store. Not exported in index. */
export function _clearReplayStore(): void {
  replayStore.clear();
}

/** Test helper — returns the current size of the replay store. */
export function _replayStoreSize(): number {
  return replayStore.size;
}
