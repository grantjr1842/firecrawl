import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { isSelfHosted } = vi.hoisted(() => ({
  isSelfHosted: vi.fn(),
}));

vi.mock("../../lib/deployment", () => ({
  isSelfHosted,
  getErrorContactMessage: vi.fn(() => ""),
}));

// Imported AFTER the mock so the middleware reads our hoisted isSelfHosted.
import { cloudOnlyRoute } from "../../middleware/cloudOnlyRoute";

const SELF_HOST_DOCS_URL = "https://docs.firecrawl.dev/contributing/self-host";

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());

  // Order matches the registrations in apps/api/src/routes/v2.ts. Each path
  // mounts the cloudOnlyRoute middleware in the same position it sits in
  // v2.ts so a regression that re-orders or drops the middleware is caught.
  app.post("/v2/parse", cloudOnlyRoute, (_req, res) => res.json({ ok: true }));
  app.post("/v2/agent", cloudOnlyRoute, (_req, res) => res.json({ ok: true }));
  app.get("/v2/agent/:jobId", cloudOnlyRoute, (_req, res) =>
    res.json({ ok: true }),
  );
  app.delete("/v2/agent/:jobId", cloudOnlyRoute, (_req, res) =>
    res.json({ ok: true }),
  );

  app.post("/v2/browser", cloudOnlyRoute, (_req, res) =>
    res.json({ ok: true }),
  );
  app.get("/v2/browser", cloudOnlyRoute, (_req, res) => res.json({ ok: true }));
  app.post(
    "/v2/browser/:sessionId/execute",
    cloudOnlyRoute,
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  app.delete("/v2/browser/:sessionId", cloudOnlyRoute, (_req, res) =>
    res.json({ ok: true }),
  );
  app.post(
    "/v2/browser/webhook/destroyed",
    cloudOnlyRoute,
    (_req, res) => {
      res.json({ ok: true });
    },
  );

  app.post("/v2/interact", cloudOnlyRoute, (_req, res) =>
    res.json({ ok: true }),
  );
  app.delete("/v2/interact/:sessionId", cloudOnlyRoute, (_req, res) =>
    res.json({ ok: true }),
  );

  app.post("/v2/monitor", cloudOnlyRoute, (_req, res) =>
    res.json({ ok: true }),
  );
  app.get("/v2/monitor", cloudOnlyRoute, (_req, res) => res.json({ ok: true }));
  app.post(
    "/v2/monitor/email/confirm",
    cloudOnlyRoute,
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  app.post(
    "/v2/monitor/email/unsubscribe",
    cloudOnlyRoute,
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  app.get("/v2/monitor/:monitorId", cloudOnlyRoute, (_req, res) =>
    res.json({ ok: true }),
  );
  app.patch("/v2/monitor/:monitorId", cloudOnlyRoute, (_req, res) =>
    res.json({ ok: true }),
  );
  app.delete("/v2/monitor/:monitorId", cloudOnlyRoute, (_req, res) =>
    res.json({ ok: true }),
  );
  app.post("/v2/monitor/:monitorId/run", cloudOnlyRoute, (_req, res) =>
    res.json({ ok: true }),
  );
  app.get("/v2/monitor/:monitorId/checks", cloudOnlyRoute, (_req, res) =>
    res.json({ ok: true }),
  );
  app.get(
    "/v2/monitor/:monitorId/checks/:checkId",
    cloudOnlyRoute,
    (_req, res) => {
      res.json({ ok: true });
    },
  );

  return app;
}

describe("cloudOnlyRoute middleware", () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("on self-hosted (USE_DB_AUTHENTICATION !== true)", () => {
    beforeEach(() => {
      isSelfHosted.mockReturnValue(true);
    });

    const gatedEndpoints: ReadonlyArray<{
      method: "get" | "post" | "patch" | "delete";
      path: string;
    }> = [
      { method: "post", path: "/v2/parse" },
      { method: "post", path: "/v2/agent" },
      { method: "get", path: "/v2/agent/abc-123" },
      { method: "delete", path: "/v2/agent/abc-123" },
      { method: "post", path: "/v2/browser" },
      { method: "get", path: "/v2/browser" },
      { method: "post", path: "/v2/browser/sess-1/execute" },
      { method: "delete", path: "/v2/browser/sess-1" },
      { method: "post", path: "/v2/browser/webhook/destroyed" },
      { method: "post", path: "/v2/interact" },
      { method: "delete", path: "/v2/interact/sess-2" },
      { method: "post", path: "/v2/monitor" },
      { method: "get", path: "/v2/monitor" },
      { method: "post", path: "/v2/monitor/email/confirm" },
      { method: "post", path: "/v2/monitor/email/unsubscribe" },
      { method: "get", path: "/v2/monitor/00000000-0000-0000-0000-000000000000" },
      { method: "patch", path: "/v2/monitor/00000000-0000-0000-0000-000000000000" },
      { method: "delete", path: "/v2/monitor/00000000-0000-0000-0000-000000000000" },
      { method: "post", path: "/v2/monitor/00000000-0000-0000-0000-000000000000/run" },
      { method: "get", path: "/v2/monitor/00000000-0000-0000-0000-000000000000/checks" },
      { method: "get", path: "/v2/monitor/00000000-0000-0000-0000-000000000000/checks/check-1" },
    ];

    it.each(gatedEndpoints)(
      "returns 501 with cloud_only envelope for $method $path",
      async ({ method, path }) => {
        const response = await (request(app) as any)[method](path).send({});

        expect(response.status).toBe(501);
        expect(response.body).toEqual({
          error: "NotImplemented",
          code: "cloud_only",
          message: expect.stringContaining(SELF_HOST_DOCS_URL),
          docs: SELF_HOST_DOCS_URL,
        });
        // Crucial: the downstream controller must not have run.
        expect(response.body.ok).toBeUndefined();
      },
    );

    it("includes the self-host feature matrix link in the message", async () => {
      const response = await request(app)
        .post("/v2/agent")
        .send({ url: "https://example.com" });

      expect(response.status).toBe(501);
      expect(response.body.message).toMatch(/self-host feature matrix/);
      expect(response.body.docs).toBe(SELF_HOST_DOCS_URL);
    });
  });

  describe("on cloud (USE_DB_AUTHENTICATION === true)", () => {
    beforeEach(() => {
      isSelfHosted.mockReturnValue(false);
    });

    it("calls next() and the controller responds normally", async () => {
      const response = await request(app)
        .post("/v2/agent")
        .send({ url: "https://example.com" });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
    });

    it("does not short-circuit browser list on cloud", async () => {
      const response = await request(app).get("/v2/browser");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
    });

    it("does not short-circuit monitor list on cloud", async () => {
      const response = await request(app).get("/v2/monitor");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
    });
  });
});
