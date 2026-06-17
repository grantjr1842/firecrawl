import { vi } from "vitest";
import express from "express";
import request from "supertest";

// admin-ops-07: when METRICS_AUTH_KEY is unset, the /metrics endpoint is
// not registered at all (404). When it is set, the endpoint requires a
// Bearer or X-Metrics-Key header that matches the configured secret.
// These tests cover both paths plus the legacy /admin/:BULL_AUTH_KEY/metrics
// back-compat route. The controller is mocked so we don't touch Redis or the
// team-semaphore module.

const {
  metricsController,
  nuqMetricsController,
} = vi.hoisted(() => ({
  metricsController: vi.fn(async (_req: unknown, res: any) => {
    res
      .status(200)
      .set("Content-Type", "text/plain; charset=utf-8")
      .send(
        '# HELP concurrency_limit_queue_job_count_total The total number of jobs across all concurrency limit queues\n# TYPE concurrency_limit_queue_job_count_total gauge\nconcurrency_limit_queue_job_count_total 0\n',
      );
  }),
  nuqMetricsController: vi.fn(async (_req: unknown, res: any) => {
    res
      .status(200)
      .set("Content-Type", "text/plain; charset=utf-8")
      .send("# HELP nuq_queue_scrape_job_count 0\n");
  }),
}));

vi.mock("../controllers/v0/admin/metrics", () => ({
  metricsController,
  nuqMetricsController,
}));

// Minimal Sentry / logger stubs so the route module can import config's
// transitive deps without booting the real SDK.
vi.mock("@sentry/node", () => ({
  addBreadcrumb: vi.fn(),
  setTag: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  getCurrentScope: () => ({ setExtra: vi.fn(), setTag: vi.fn() }),
  init: vi.fn(),
  vercelAIIntegration: vi.fn(() => ({})),
  setupExpressErrorHandler: vi.fn(),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Configurable config so we can flip METRICS_AUTH_KEY / BULL_AUTH_KEY per test.
const configState: {
  BULL_AUTH_KEY?: string;
  METRICS_AUTH_KEY?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_ERROR_SAMPLE_RATE?: number;
  SENTRY_TRACE_SAMPLE_RATE?: number;
  NUQ_POD_NAME?: string;
} = vi.hoisted(() => ({
  BULL_AUTH_KEY: "test-bull-key",
  METRICS_AUTH_KEY: undefined,
  SENTRY_DSN: undefined,
  SENTRY_ENVIRONMENT: "test",
  SENTRY_ERROR_SAMPLE_RATE: 0,
  SENTRY_TRACE_SAMPLE_RATE: 0,
  NUQ_POD_NAME: "test-pod",
}));

vi.mock("../config", () => ({ config: configState }));

async function loadAppWithConfig(): Promise<express.Express> {
  // The router registers routes conditionally at import time based on
  // config.METRICS_AUTH_KEY, so each test that wants a different config
  // needs a fresh module graph.
  vi.resetModules();
  // Re-apply the hoisted mocks (vi.resetModules clears module state but
  // hoisted mocks persist on the vi.mock side).
  const { metricsRouter } = await import("./metrics");
  const { adminRouter } = await import("./admin");

  const app = express();
  // The legacy /admin/:BULL_AUTH_KEY/metrics route lives in adminRouter.
  // We re-mount both so a regression in either is caught.
  app.use(metricsRouter);
  app.use(adminRouter);
  return app;
}

describe("metrics router (admin-ops-07)", () => {
  const VALID_KEY = "this-is-a-very-long-metrics-auth-key-1234567890";

  beforeEach(() => {
    vi.clearAllMocks();
    configState.METRICS_AUTH_KEY = undefined;
    configState.BULL_AUTH_KEY = "test-bull-key";
  });

  it("returns 404 for GET /metrics when METRICS_AUTH_KEY is unset", async () => {
    configState.METRICS_AUTH_KEY = undefined;
    const app = await loadAppWithConfig();

    const res = await request(app).get("/metrics");

    expect(res.status).toBe(404);
    expect(metricsController).not.toHaveBeenCalled();
  });

  it("returns 401 for GET /metrics with METRICS_AUTH_KEY set but no auth header", async () => {
    configState.METRICS_AUTH_KEY = VALID_KEY;
    const app = await loadAppWithConfig();

    const res = await request(app).get("/metrics");

    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/Bearer/i);
    expect(metricsController).not.toHaveBeenCalled();
  });

  it("returns 401 for GET /metrics with METRICS_AUTH_KEY set but a wrong key", async () => {
    configState.METRICS_AUTH_KEY = VALID_KEY;
    const app = await loadAppWithConfig();

    const res = await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer not-the-real-key-aaaaaaaaaaaaaa");

    expect(res.status).toBe(401);
    expect(metricsController).not.toHaveBeenCalled();
  });

  it("returns 200 + prom text for GET /metrics with the correct Bearer token", async () => {
    configState.METRICS_AUTH_KEY = VALID_KEY;
    const app = await loadAppWithConfig();

    const res = await request(app)
      .get("/metrics")
      .set("Authorization", `Bearer ${VALID_KEY}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("concurrency_limit_queue_job_count_total");
    expect(metricsController).toHaveBeenCalledTimes(1);
  });

  it("accepts the X-Metrics-Key header as an alternative to Authorization", async () => {
    configState.METRICS_AUTH_KEY = VALID_KEY;
    const app = await loadAppWithConfig();

    const res = await request(app)
      .get("/metrics")
      .set("X-Metrics-Key", VALID_KEY);

    expect(res.status).toBe(200);
    expect(metricsController).toHaveBeenCalledTimes(1);
  });

  it("gates the /metrics/nuq endpoint the same way", async () => {
    configState.METRICS_AUTH_KEY = VALID_KEY;
    const app = await loadAppWithConfig();

    const unauthorized = await request(app).get("/metrics/nuq");
    expect(unauthorized.status).toBe(401);
    expect(nuqMetricsController).not.toHaveBeenCalled();

    const authorized = await request(app)
      .get("/metrics/nuq")
      .set("X-Metrics-Key", VALID_KEY);
    expect(authorized.status).toBe(200);
    expect(nuqMetricsController).toHaveBeenCalledTimes(1);
  });

  it("preserves the legacy /admin/:BULL_AUTH_KEY/metrics back-compat path", async () => {
    configState.METRICS_AUTH_KEY = VALID_KEY;
    configState.BULL_AUTH_KEY = "legacy-bull-key";
    const app = await loadAppWithConfig();

    const res = await request(app).get("/admin/legacy-bull-key/metrics");

    expect(res.status).toBe(200);
    expect(res.text).toContain("concurrency_limit_queue_job_count_total");
    expect(metricsController).toHaveBeenCalledTimes(1);
  });

  it("rejects the legacy /admin path when BULL_AUTH_KEY is wrong", async () => {
    configState.METRICS_AUTH_KEY = VALID_KEY;
    configState.BULL_AUTH_KEY = "legacy-bull-key";
    const app = await loadAppWithConfig();

    const res = await request(app).get("/admin/wrong-key/metrics");

    expect(res.status).toBe(404);
    expect(metricsController).not.toHaveBeenCalled();
  });
});
