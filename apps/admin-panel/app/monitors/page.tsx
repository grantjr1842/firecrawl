/**
 * /monitors — the dashboard skeleton for the monitor-admin controller.
 *
 * For the foundation, we only render the list endpoint output. The
 * diff viewer and claim button are the multi-week followup; both
 * already have typed wrappers in `lib/api.ts` so the next agent can
 * add the UI without re-deriving the contract.
 */
import { listAdminMonitors } from "../../lib/api";

export const dynamic = "force-dynamic";

export default async function MonitorsPage() {
  const result = await listAdminMonitors();

  if (!result.success) {
    return (
      <section>
        <h1 style={{ marginTop: 0 }}>Monitors</h1>
        <p style={{ color: "#9aa3ad" }}>
          Reads <code>GET /v2/monitor/admin/list</code> from the firecrawl-api.
        </p>
        <div
          role="status"
          data-testid="monitors-status"
          data-ok="false"
          style={{
            padding: "1.5rem",
            borderRadius: 8,
            background: "#2a0f12",
            border: "1px solid #5c1d20",
          }}
        >
          <strong style={{ color: "#ff7a85" }}>Controller unavailable</strong>
          <div style={{ marginTop: 8, color: "#c2c8d0" }}>{result.error}</div>
        </div>
      </section>
    );
  }

  const monitors = result.data;
  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Monitors</h1>
      <p style={{ color: "#9aa3ad" }}>
        {monitors.length} monitor{monitors.length === 1 ? "" : "s"} on the
        caller's team.
      </p>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          marginTop: "1rem",
        }}
      >
        <thead>
          <tr style={{ textAlign: "left", color: "#9aa3ad" }}>
            <th style={{ padding: "0.5rem" }}>Name</th>
            <th style={{ padding: "0.5rem" }}>Status</th>
            <th style={{ padding: "0.5rem" }}>Cron</th>
            <th style={{ padding: "0.5rem" }}>Next run</th>
          </tr>
        </thead>
        <tbody>
          {monitors.map(m => (
            <tr key={m.id} style={{ borderTop: "1px solid #1f2329" }}>
              <td style={{ padding: "0.5rem" }}>{m.name}</td>
              <td style={{ padding: "0.5rem" }}>{m.status}</td>
              <td style={{ padding: "0.5rem" }}>
                <code>{m.scheduleCron}</code>
              </td>
              <td style={{ padding: "0.5rem" }}>
                {m.nextRunAt ?? <span style={{ color: "#6c7280" }}>—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
