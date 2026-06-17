import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { NextFunction, Request, Response } from "express";
import request from "supertest";
import {
  replayMiddleware,
  _clearReplayStore,
  _replayStoreSize,
} from "../../services/idempotency/replay";

/**
 * End-to-end smoke test for `idempotency.replayMiddleware`.
 *
 * The middleware's response-capture path wraps `res.json` and `res.send`.
 * This test simulates the failure mode flagged in the post-ultracode
 * recommendations: a route throws, the global error handler calls
 * `res.json`, and we want to confirm the wrapper still records the
 * response (or correctly skips it for error statuses) and that subsequent
 * retries with the same `x-idempotency-key` replay the captured body.
 *
 * Network-blip simulation: a request that succeeds is "lost" client-side,
 * the client retries with the same idempotency key, and the server must
 * return the original response without re-running the route handler.
 */

// Minimal global error handler that mirrors the production handler in
// src/index.ts: Sentry id is omitted; res.status(500).json({...}).
function makeErrorHandler() {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ success: false, error: message });
  };
}

describe("replayMiddleware – response-capture path", () => {
  beforeEach(() => {
    _clearReplayStore();
  });

  afterEach(() => {
    _clearReplayStore();
    vi.restoreAllMocks();
  });

  it("captures a successful res.json response and replays it on retry", async () => {
    const handler = vi.fn((_req: Request, res: Response) => {
      res.status(200).json({ ok: true, data: "scrape-result-42" });
    });

    const app = express();
    app.use(replayMiddleware);
    app.post("/scrape", handler);
    app.use(makeErrorHandler());

    const idempotencyKey = "11111111-1111-4111-8111-111111111111";

    // First request: the route handler runs and the response is captured.
    const first = await request(app)
      .post("/scrape")
      .set("x-idempotency-key", idempotencyKey)
      .send({ url: "https://example.com" });

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, data: "scrape-result-42" });
    expect(first.headers["x-idempotency-replayed"]).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(_replayStoreSize()).toBe(1);

    // Network blip: the client never received the response and retries
    // with the same key. The handler MUST NOT run again.
    const retry = await request(app)
      .post("/scrape")
      .set("x-idempotency-key", idempotencyKey)
      .send({ url: "https://example.com" });

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ok: true, data: "scrape-result-42" });
    expect(retry.headers["x-idempotency-replayed"]).toBe("true");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not capture or replay when no idempotency key is provided", async () => {
    const handler = vi.fn((_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    });

    const app = express();
    app.use(replayMiddleware);
    app.post("/scrape", handler);
    app.use(makeErrorHandler());

    const first = await request(app)
      .post("/scrape")
      .send({ url: "https://example.com" });

    const second = await request(app)
      .post("/scrape")
      .send({ url: "https://example.com" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(_replayStoreSize()).toBe(0);
  });

  it("captures distinct responses for distinct idempotency keys", async () => {
    const handler = vi.fn((req: Request, res: Response) => {
      const key = req.headers["x-idempotency-key"] as string;
      res.status(200).json({ ok: true, key });
    });

    const app = express();
    app.use(replayMiddleware);
    app.post("/scrape", handler);
    app.use(makeErrorHandler());

    const keyA = "22222222-2222-4222-8222-222222222222";
    const keyB = "33333333-3333-4333-8333-333333333333";

    const a = await request(app)
      .post("/scrape")
      .set("x-idempotency-key", keyA)
      .send({});
    const b = await request(app)
      .post("/scrape")
      .set("x-idempotency-key", keyB)
      .send({});

    expect(a.body.key).toBe(keyA);
    expect(b.body.key).toBe(keyB);
    expect(_replayStoreSize()).toBe(2);

    // Retries replay the right responses.
    const aRetry = await request(app)
      .post("/scrape")
      .set("x-idempotency-key", keyA)
      .send({});
    expect(aRetry.body.key).toBe(keyA);
    expect(aRetry.headers["x-idempotency-replayed"]).toBe("true");
  });

  /**
   * This is the regression the post-ultracode followup flagged:
   * "the response-capture path is a per-request res.json override that
   * may interact poorly with the global error handler in src/index.ts".
   *
   * We assert that:
   *   (1) the error handler's res.json call flows through our wrapper
   *       (it must — Express res is a singleton per request)
   *   (2) the wrapper does NOT cache a 500 response, so a retry with
   *       the same key can actually succeed once the upstream is fixed
   *   (3) the wrapper does not throw or hang when res.json is invoked
   *       from the error path
   */
  it("does not capture 5xx error responses (regression: res.json + global error handler)", async () => {
    let attempt = 0;
    const handler = (_req: Request, _res: Response, next: NextFunction) => {
      attempt += 1;
      // First call: throw. Second call: succeed.
      if (attempt === 1) {
        return next(new Error("upstream blew up"));
      }
      _res.status(200).json({ ok: true, attempt });
    };

    const app = express();
    app.use(replayMiddleware);
    app.post("/scrape", handler);
    app.use(makeErrorHandler());

    const key = "44444444-4444-4444-8444-444444444444";

    // First attempt: the route throws, the error handler writes a 500.
    // The wrapper observes that res.statusCode >= 400 and does NOT
    // capture the response (network blips should be replay-safe only
    // for successful responses).
    const first = await request(app)
      .post("/scrape")
      .set("x-idempotency-key", key)
      .send({});

    expect(first.status).toBe(500);
    expect(first.body).toEqual({
      success: false,
      error: "upstream blew up",
    });
    expect(_replayStoreSize()).toBe(0);

    // Retry: the key is still free, so the route handler runs again.
    const retry = await request(app)
      .post("/scrape")
      .set("x-idempotency-key", key)
      .send({});

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ok: true, attempt: 2 });
    expect(retry.headers["x-idempotency-replayed"]).toBeUndefined();
  });

  it("preserves the captured status code on replay", async () => {
    const handler = (_req: Request, res: Response) => {
      res.status(201).json({ created: true });
    };

    const app = express();
    app.use(replayMiddleware);
    app.post("/scrape", handler);
    app.use(makeErrorHandler());

    const key = "55555555-5555-4555-8555-555555555555";

    const first = await request(app)
      .post("/scrape")
      .set("x-idempotency-key", key)
      .send({});
    expect(first.status).toBe(201);

    const retry = await request(app)
      .post("/scrape")
      .set("x-idempotency-key", key)
      .send({});
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ created: true });
    expect(retry.headers["x-idempotency-replayed"]).toBe("true");
  });
});
