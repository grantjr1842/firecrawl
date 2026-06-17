import { vi } from "vitest";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const {
  addBreadcrumb,
  setTag,
  captureException,
  captureMessage,
} = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  setTag: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const { loggerInfo, loggerError, loggerWarn } = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  addBreadcrumb,
  setTag,
  captureException,
  captureMessage,
  getCurrentScope: () => ({ setExtra: vi.fn(), setTag: vi.fn() }),
  init: vi.fn(),
  vercelAIIntegration: vi.fn(() => ({})),
}));

vi.mock("../../config", () => ({
  config: {
    BULL_AUTH_KEY: "test-bull-key",
    SENTRY_DSN: "https://test@sentry.test/123",
    SENTRY_ENVIRONMENT: "test",
    SENTRY_ERROR_SAMPLE_RATE: 1,
    SENTRY_TRACE_SAMPLE_RATE: 0,
    NUQ_POD_NAME: "test-pod",
  },
}));

vi.mock("../logger", () => ({
  logger: {
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
    debug: vi.fn(),
  },
}));

vi.mock("../scraper/scrapeURL/error", () => ({
  AddFeatureError: class extends Error {},
  RemoveFeatureError: class extends Error {},
  EngineError: class extends Error {},
}));

vi.mock("../scraper/scrapeURL/lib/abortManager", () => ({
  AbortManagerThrownError: class extends Error {},
}));

vi.mock("../lib/error", () => ({
  JobCancelledError: class extends Error {},
}));

vi.mock("../lib/queue-full-error", () => ({
  isQueueFullError: () => false,
}));

import {
  adminAuthMiddleware,
  adminRateLimit,
  adminRateLimitMiddleware,
  resetAdminRateLimits,
} from "../../lib/adminAuth";

function buildApp(opts: { rateLimit?: boolean } = {}) {
  const app = express();
  app.use(express.json());

  // Mount the middleware manually so each test gets a fresh app instance
  // (and so we don't depend on the bull-board base path).
  app.use(adminAuthMiddleware);

  if (opts.rateLimit) {
    app.post("/admin/x/acuc-cache-clear", adminRateLimitMiddleware(10_000, 1), (
      req: Request,
      res: Response,
    ) => {
      res.json({ ok: true });
    });
  } else {
    app.post("/admin/x/acuc-cache-clear", (req: Request, res: Response) => {
      res.json({ ok: true });
    });
  }

  // Echo the stashed admin actor/target so tests can verify they survived
  // the middleware hop.
  app.get("/admin/x/echo", (req: Request, res: Response) => {
    res.json({
      actor: (req as any).adminActor ?? null,
      target: (req as any).adminTarget ?? null,
      ip: (req as any).adminIp ?? null,
    });
  });

  // GET path through the same router — must NOT require X-Admin-Actor-Email.
  app.get("/admin/x/redis-health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // Error sink so we don't pollute test output.
  app.use(
    (err: any, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: err?.message ?? "error" });
    },
  );

  return app;
}

describe("adminAuthMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAdminRateLimits();
  });

  it("rejects POST acuc-cache-clear without X-Admin-Actor-Email with 400", async () => {
    const app = buildApp();

    const res = await request(app)
      .post("/admin/x/acuc-cache-clear")
      .send({ team_id: "team_abc" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: "admin_actor_required",
    });
  });

  it("accepts POST with X-Admin-Actor-Email header and stashes actor/target/ip", async () => {
    const app = buildApp();

    const res = await request(app)
      .post("/admin/x/acuc-cache-clear")
      .set("X-Admin-Actor-Email", "ops@firecrawl.dev")
      .set("X-Forwarded-For", "203.0.113.7")
      .send({ team_id: "team_xyz" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("echo route exposes actor/target/ip stashed by the middleware", async () => {
    const app = buildApp();

    const res = await request(app)
      .get("/admin/x/echo")
      .set("X-Admin-Actor-Email", "ops@firecrawl.dev")
      .set("X-Forwarded-For", "203.0.113.7");

    expect(res.status).toBe(200);
    expect(res.body.actor).toBe("ops@firecrawl.dev");
    expect(res.body.ip).toBe("203.0.113.7");
  });

  it("writes a structured admin_action winston log on every call", async () => {
    const app = buildApp();

    await request(app)
      .post("/admin/x/acuc-cache-clear")
      .set("X-Admin-Actor-Email", "ops@firecrawl.dev")
      .send({ team_id: "team_xyz" });

    const adminLogs = loggerInfo.mock.calls.filter(call => {
      const arg = call[0];
      return arg === "admin_action";
    });
    expect(adminLogs.length).toBeGreaterThanOrEqual(1);

    const [, payload] = adminLogs[0];
    expect(payload).toMatchObject({
      module: "adminAuth",
      canonicalLog: "admin/action",
      actor: "ops@firecrawl.dev",
      target: "team_xyz",
      method: "POST",
    });
  });

  it("also logs rejected (missing-actor) requests so the attempt is auditable", async () => {
    const app = buildApp();

    await request(app)
      .post("/admin/x/acuc-cache-clear")
      .send({ team_id: "team_xyz" });

    const rejectionLogs = loggerInfo.mock.calls.filter(call => {
      const arg = call[0];
      return arg === "admin_action";
    });
    expect(rejectionLogs.length).toBeGreaterThanOrEqual(1);
    const [, payload] = rejectionLogs[0];
    expect(payload).toMatchObject({
      actor: null,
      target: "team_xyz",
      status: 400,
    });
  });

  it("emits a Sentry breadcrumb on every admin call", async () => {
    const app = buildApp();

    await request(app)
      .post("/admin/x/acuc-cache-clear")
      .set("X-Admin-Actor-Email", "ops@firecrawl.dev")
      .send({ team_id: "team_xyz" });

    expect(addBreadcrumb).toHaveBeenCalled();
    const breadcrumb = addBreadcrumb.mock.calls[0][0];
    expect(breadcrumb.category).toBe("admin");
    expect(breadcrumb.level).toBe("warning");
    expect(breadcrumb.data.actor).toBe("ops@firecrawl.dev");
    expect(breadcrumb.data.target).toBe("team_xyz");
  });

  it("does NOT require X-Admin-Actor-Email for GET admin routes", async () => {
    const app = buildApp();

    const res = await request(app).get("/admin/x/redis-health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("rate-limits acuc-cache-clear to 1 call / 10s per BULL_AUTH_KEY", async () => {
    const app = buildApp({ rateLimit: true });

    const first = await request(app)
      .post("/admin/x/acuc-cache-clear")
      .set("X-Admin-Actor-Email", "ops@firecrawl.dev")
      .send({ team_id: "team_xyz" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/admin/x/acuc-cache-clear")
      .set("X-Admin-Actor-Email", "ops@firecrawl.dev")
      .send({ team_id: "team_xyz" });
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({
      success: false,
      error: "admin_rate_limited",
    });
    expect(second.headers["retry-after"]).toBeDefined();
  });

  it("adminRateLimit returns allowed=false once max is exceeded", () => {
    resetAdminRateLimits();
    const first = adminRateLimit("k", 10_000, 1);
    const second = adminRateLimit("k", 10_000, 1);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
  });

  it("adminRateLimit allows calls again after the window expires (simulated via reset)", () => {
    resetAdminRateLimits();
    expect(adminRateLimit("k", 10_000, 1).allowed).toBe(true);
    expect(adminRateLimit("k", 10_000, 1).allowed).toBe(false);
    resetAdminRateLimits();
    expect(adminRateLimit("k", 10_000, 1).allowed).toBe(true);
  });
});