/**
 * T1.3 admin-panel → firecrawl-api client.
 *
 * Foundation for the operator-facing admin panel. The Next.js side is
 * read-mostly (operators inspect, not mutate); mutations go through the
 * existing v2 endpoints with an `X-Admin-Role: admin` header so the
 * server-side `requireTeamRole` middleware can let the call through.
 *
 * The base URL points at the same cluster the api runs on. In
 * self-hosted deployments the operator sets `FIRECRAWL_API_URL` (e.g.
 * `http://firecrawl-api:3002`); in dev we default to localhost:3002
 * which matches `pnpm dev` for the api.
 */

export const DEFAULT_API_BASE_URL = "http://localhost:3002";

export function getApiBaseUrl(): string {
  return process.env.FIRECRAWL_API_URL ?? DEFAULT_API_BASE_URL;
}

export type HealthResponse = { status: "ok" | string };

export type ApiError = {
  success: false;
  error: string;
  status: number;
};

export type ApiResult<T> = { success: true; data: T } | ApiError;

/**
 * GET /v0/health/liveness — the cheapest liveness probe the api
 * exposes. Returns `{ status: "ok" }` on 200, anything else surfaces
 * the HTTP status so the operator can tell a 502 from a 404.
 *
 * Used by the /health page. Server-side fetch (Next.js App Router
 * default), so a misconfigured FIRECRAWL_API_URL is caught at SSR
 * time, not on the client.
 */
export async function getLiveness(
  baseUrl: string = getApiBaseUrl(),
): Promise<ApiResult<HealthResponse>> {
  const url = `${baseUrl.replace(/\/$/, "")}/v0/health/liveness`;
  try {
    const response = await fetch(url, {
      // Admin-panel pages are always revalidated on load. We don't
      // want a 5-minute-stale "ok" hiding a fresh outage.
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        success: false,
        error: `upstream ${response.status} ${response.statusText}`,
        status: response.status,
      };
    }
    const body = (await response.json()) as HealthResponse;
    return { success: true, data: body };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: 0,
    };
  }
}

export type MonitorSummary = {
  id: string;
  name: string;
  status: string;
  scheduleCron: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
};

/**
 * GET /v2/monitor/admin/list — the operator view into all monitors
 * for the caller's team. Requires `requireTeamRole("admin")` on the
 * server side; the panel passes the role header so the api can
 * short-circuit the JWT decode path.
 *
 * In the foundation we expose a typed wrapper but call it best-effort
 * (returns the error envelope) so the page can render a useful
 * "unavailable in self-host" state instead of crashing.
 */
export async function listAdminMonitors(
  baseUrl: string = getApiBaseUrl(),
  apiKey?: string,
): Promise<ApiResult<MonitorSummary[]>> {
  const url = `${baseUrl.replace(/\/$/, "")}/v2/monitor/admin/list`;
  // The server-side requireAdmin middleware accepts either the operator
  // header alone, or the header + a bearer token whose key matches
  // ADMIN_API_KEYS on the api. We always send the header so the api can
  // short-circuit the JWT decode path; the bearer token is read from
  // NEXT_PUBLIC_ADMIN_PANEL_API_KEY (exposed by next.config.mjs) so
  // operators only have to set the env var once.
  const envKey =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_ADMIN_PANEL_API_KEY
      : undefined;
  const effectiveKey = apiKey ?? (envKey && envKey.length > 0 ? envKey : undefined);
  const headers: Record<string, string> = {
    "X-Admin-Role": "admin",
  };
  if (effectiveKey) headers["Authorization"] = `Bearer ${effectiveKey}`;
  try {
    const response = await fetch(url, { headers, cache: "no-store" });
    if (response.status === 404) {
      // Self-host deployments won't have the admin controller
      // mounted yet. Treat that as "unavailable" rather than an
      // error so the dashboard can still render.
      return {
        success: false,
        error: "monitor-admin controller not mounted (self-host)",
        status: 404,
      };
    }
    if (!response.ok) {
      return {
        success: false,
        error: `upstream ${response.status} ${response.statusText}`,
        status: response.status,
      };
    }
    const body = (await response.json()) as {
      success: boolean;
      data?: MonitorSummary[];
      error?: string;
    };
    if (!body.success || !body.data) {
      return {
        success: false,
        error: body.error ?? "unknown upstream error",
        status: response.status,
      };
    }
    return { success: true, data: body.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: 0,
    };
  }
}
