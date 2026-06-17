/**
 * /health — the one working page in the foundation.
 *
 * Calls the api's liveness probe (server-side fetch with `cache: "no-store"`)
 * and renders the result. The page is a Server Component so the API URL
 * never leaks to the client and a misconfigured `FIRECRAWL_API_URL`
 * is caught at SSR time.
 *
 * Why liveness and not readiness:
 *   - liveness answers "is the process alive" — the simplest signal.
 *   - readiness answers "is the process ready to serve traffic" —
 *     depends on Redis, Postgres, etc. Wiring readiness here would
 *     couple the panel to a future migration that may or may not
 *     land. Foundation stays minimal.
 */
import { getLiveness } from "../../lib/api";

export const dynamic = "force-dynamic";

export default async function HealthPage() {
  const result = await getLiveness();
  const ok = result.success && result.data?.status === "ok";

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Cluster health</h1>
      <p style={{ color: "#9aa3ad" }}>
        Probes <code>GET /v0/health/liveness</code> on the firecrawl-api.
      </p>

      <div
        role="status"
        data-testid="health-status"
        data-ok={ok ? "true" : "false"}
        style={{
          padding: "1.5rem",
          borderRadius: 8,
          background: ok ? "#0f2a1a" : "#2a0f12",
          border: `1px solid ${ok ? "#1c5230" : "#5c1d20"}`,
        }}
      >
        <strong style={{ color: ok ? "#5be19e" : "#ff7a85" }}>
          {ok ? "OK" : "Down"}
        </strong>
        <div style={{ marginTop: 8, color: "#c2c8d0" }}>
          {result.success
            ? `Response: ${JSON.stringify(result.data)}`
            : `Error: ${result.error}${result.status ? ` (status ${result.status})` : ""}`}
        </div>
      </div>
    </section>
  );
}
