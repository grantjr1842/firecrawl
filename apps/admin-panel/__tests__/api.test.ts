/**
 * Foundation tests for the admin-panel → firecrawl-api client.
 *
 * The dashboard itself is hard to unit-test without spinning up Next,
 * but the wrapper layer is pure HTTP and easy to drive. These tests
 * pin down the three behaviors that matter for the foundation:
 *
 *   1. 200 → success envelope
 *   2. non-2xx → error envelope with status
 *   3. self-host 404 on the admin controller → graceful "unavailable"
 *      (not a crash), because the controller isn't mounted in
 *      self-hosted deployments yet.
 *
 * The Node 18+ global `fetch` is patched per-test so we don't need
 * MSW or undici. We re-export the tested functions under their
 * post-`lib/api` names so a casual reader finds them in the lib
 * directory.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getLiveness,
  listAdminMonitors,
  getApiBaseUrl,
} from "../lib/api";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("getApiBaseUrl", () => {
  it("defaults to localhost:3002", () => {
    const previous = process.env.FIRECRAWL_API_URL;
    delete process.env.FIRECRAWL_API_URL;
    try {
      expect(getApiBaseUrl()).toBe("http://localhost:3002");
    } finally {
      if (previous !== undefined) {
        process.env.FIRECRAWL_API_URL = previous;
      }
    }
  });

  it("honors FIRECRAWL_API_URL", () => {
    process.env.FIRECRAWL_API_URL = "http://firecrawl-api:3002";
    try {
      expect(getApiBaseUrl()).toBe("http://firecrawl-api:3002");
    } finally {
      delete process.env.FIRECRAWL_API_URL;
    }
  });
});

describe("getLiveness", () => {
  it("returns success envelope on 200", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const result = await getLiveness("http://api:3002");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("ok");
    }
  });

  it("returns error envelope on 5xx", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("upstream down", { status: 502 }),
    ) as unknown as typeof fetch;
    const result = await getLiveness("http://api:3002");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(502);
      expect(result.error).toContain("502");
    }
  });

  it("returns error envelope on network failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    const result = await getLiveness("http://api:3002");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("ECONNREFUSED");
      expect(result.status).toBe(0);
    }
  });

  it("strips a trailing slash from the base URL", async () => {
    const calls: string[] = [];
    global.fetch = vi.fn().mockImplementation((input: RequestInfo) => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    await getLiveness("http://api:3002/");
    expect(calls[0]).toBe("http://api:3002/v0/health/liveness");
  });
});

describe("listAdminMonitors", () => {
  it("returns success envelope on 200 with monitors", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: [
            {
              id: "11111111-1111-1111-1111-111111111111",
              name: "example.com",
              status: "active",
              scheduleCron: "*/15 * * * *",
              nextRunAt: "2026-06-16T20:30:00Z",
              lastRunAt: "2026-06-16T20:15:00Z",
            },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const result = await listAdminMonitors("http://api:3002");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe("example.com");
    }
  });

  it("treats 404 as 'controller unavailable' (self-host)", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    ) as unknown as typeof fetch;
    const result = await listAdminMonitors("http://api:3002");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(404);
      expect(result.error).toContain("not mounted");
    }
  });

  it("returns error envelope when upstream body has success=false", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: "forbidden" }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const result = await listAdminMonitors("http://api:3002");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("forbidden");
    }
  });

  it("sends the X-Admin-Role header and bearer token when given", async () => {
    const seen: { url: string; init: RequestInit | undefined } = {
      url: "",
      init: undefined,
    };
    global.fetch = vi.fn().mockImplementation((input: RequestInfo, init?: RequestInit) => {
      seen.url = String(input);
      seen.init = init;
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;
    await listAdminMonitors("http://api:3002", "test-key");
    expect(seen.url).toBe("http://api:3002/v2/monitor/admin/list");
    const headers = (seen.init?.headers ?? {}) as Record<string, string>;
    expect(headers["X-Admin-Role"]).toBe("admin");
    expect(headers["Authorization"]).toBe("Bearer test-key");
  });
});
