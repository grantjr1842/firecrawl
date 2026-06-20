// ADMIN-RL-BUCKET-FALLBACK: when BULL_AUTH_KEY is unset (the default
// for self-hosted installs), every cluster would otherwise collapse
// onto the literal "unknown" rate-limit bucket — a misconfigured
// multi-pod install could DoS its own admin endpoints.
//
// We assert the documented behaviour: with BULL_AUTH_KEY unset the
// middleware short-circuits to next() and never touches the in-process
// `adminRateLimit` LRU (so each pod enforces its own bucket). When
// BULL_AUTH_KEY is set the existing key-based partitioning runs.

import type { NextFunction, Request, Response } from "express";
import {
  adminRateLimitMiddleware,
  resetAdminRateLimits,
} from "../../lib/adminAuth";

function buildReq(opts: {
  path?: string;
  method?: string;
  headerStore?: Record<string, string>;
} = {}): Request {
  const headerStore: Record<string, string> = opts.headerStore ?? {};
  const req = {
    method: opts.method ?? "POST",
    path: opts.path ?? "/admin/queue/pause",
    originalUrl: opts.path ?? "/admin/queue/pause",
    headers: {
      "x-forwarded-for": "203.0.113.5",
      ...headerStore,
    },
    ip: "127.0.0.1",
    body: {},
  } as unknown as Request;
  return req;
}

function buildRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    headersSent: false,
  } as unknown as Response;
  return res;
}

describe("adminRateLimitMiddleware (ADMIN-RL-BUCKET-FALLBACK)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAdminRateLimits();
  });

  it("calls next() and does not 429 when BULL_AUTH_KEY is unset", async () => {
    vi.resetModules();
    vi.doMock("../../config", () => ({
      config: { BULL_AUTH_KEY: undefined },
    }));
    const { adminRateLimitMiddleware: mw } = await import(
      "../../lib/adminAuth"
    );
    const middleware = mw(10_000, 1); // max 1 per 10s
    const req = buildReq();
    const res = buildRes();
    const next = vi.fn() as unknown as NextFunction;

    // Hammer it 5 times in a row — would 429 if the rate limiter
    // were active, but with BULL_AUTH_KEY unset we short-circuit.
    for (let i = 0; i < 5; i += 1) {
      middleware(req, res, next);
    }

    expect(next).toHaveBeenCalledTimes(5);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
