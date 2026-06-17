// NEW #2 — requireAdmin middleware guard for /v2/monitor/admin/list.
//
// Three cases the route expects:
//   1. Operator sends X-Admin-Role: admin → 200, next() invoked.
//   2. Caller omits the header AND the JWT email is not in ADMIN_EMAILS
//      → 403 with `error: "Admin role required"`.
//   3. ADMIN_EMAILS allowlist matches the JWT email → 200, next()
//      invoked (so self-host operators can use a regular API key whose
//      email is on the allowlist without the operator header).
//
// The middleware only consults config + req headers + req.acuc.email,
// so no DB / Autumn / scraper mocks are needed.

vi.mock("../../config", () => ({
  config: {
    ADMIN_EMAILS: "ops@firecrawl.dev,admin@firecrawl.dev",
  },
}));

import type { NextFunction, Response } from "express";
import type { RequestWithAuth } from "../../controllers/v1/types";
import { requireAdmin } from "../../routes/shared";

function buildReq(opts: {
  headerStore?: Record<string, string>;
  email?: string;
} = {}): RequestWithAuth {
  const headerStore: Record<string, string> = opts.headerStore ?? {};
  const req = {
    auth: { team_id: "team_test", org_id: "org_test" },
    acuc: { email: opts.email ?? "user@firecrawl.dev" } as any,
    header(name: string) {
      return headerStore[name.toLowerCase()];
    },
  } as unknown as RequestWithAuth;
  return req;
}

function buildRes(): { res: Response; status: any; json: any } {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    headersSent: false,
  } as unknown as Response;
  (res as any).status.mockImplementation(() => res);
  (res as any).json.mockImplementation(() => res);
  return { res: res as any, status: (res as any).status, json: (res as any).json };
}

describe("requireAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets through when X-Admin-Role: admin header is present", () => {
    const req = buildReq({ headerStore: { "x-admin-role": "admin" } });
    const { res } = buildRes();
    const next = vi.fn() as unknown as NextFunction;

    requireAdmin(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 403 when header is missing and email is not in ADMIN_EMAILS", () => {
    const req = buildReq({ email: "user@firecrawl.dev" });
    const { res } = buildRes();
    const next = vi.fn() as unknown as NextFunction;

    requireAdmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Admin role required",
    });
  });

  it("lets through when JWT email matches an entry in ADMIN_EMAILS", () => {
    const req = buildReq({ email: "ops@firecrawl.dev" });
    const { res } = buildRes();
    const next = vi.fn() as unknown as NextFunction;

    requireAdmin(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("still returns 403 when the JWT email is wrong even if the header is absent", () => {
    const req = buildReq({ email: "user@firecrawl.dev" });
    const { res } = buildRes();
    const next = vi.fn() as unknown as NextFunction;

    requireAdmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});