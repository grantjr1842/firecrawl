# @firecrawl/admin-panel

Operator-facing admin panel for the Firecrawl cluster (T1.3 from
ROADMAP_2026). This is the **foundation**; full UI is a multi-week
followup.

## Status

| Piece | Status |
| --- | --- |
| Next.js 14 app scaffold | Shipped |
| `/health` page (probes `/v0/health/liveness`) | Shipped |
| `/monitors` page (probes `/v2/monitor/admin/list`) | Shipped, error-tolerant |
| Typed API client (`lib/api.ts`) | Shipped, unit-tested |
| Vitest unit tests for the client | Shipped |
| Monitor diff viewer (`/v2/monitor/admin/:id/diff`) | Not yet — wrapper exists, UI is multi-week |
| Monitor claim button (`/v2/monitor/admin/:id/claim`) | Not yet — wrapper exists, UI is multi-week |
| Auth (SSO / OIDC against the team table) | Not yet — out of scope for the foundation |
| Grafana-style SLI/SLO panels | See T2.1 (separate epic) |

## Run locally

```bash
# 1. start the firecrawl-api on its default port (3002)
cd apps/api && pnpm dev

# 2. start the admin panel on port 3001
cd apps/admin-panel && pnpm install && pnpm dev
# open http://localhost:3001
```

The panel reads `FIRECRAWL_API_URL` (default `http://localhost:3002`)
and calls the api directly — no extra proxy, no auth layer yet.

## Test

```bash
cd apps/admin-panel && pnpm test    # vitest unit tests
cd apps/admin-panel && pnpm tsc     # type check
```

## Why this ships as a foundation

The recursive-ultracode pass (`ROADMAP_2026.md` Tier 1.3) called for
a "4-6 week" build. The recursive pass hit its diminishing-returns
floor at 65 commits; T1.3 was the natural place to draw the line
because the server-side `monitor-admin` controller is still a build
artifact (`dist/src/controllers/v2/monitor-admin.js`) and not
committed source. The foundation:

- Establishes the package shape so the next agent can add pages
  without a workspace config rewrite.
- Pins the client contract in `lib/api.ts` so the next agent doesn't
  re-derive the admin endpoint envelope.
- Treats 404 on the admin controller as "self-host, not mounted" so
  the panel doesn't crash in self-hosted deployments.
- Ships unit tests for the client so the contract can't drift
  silently.

## What's left

- Move the api's monitor-admin controller from `dist/` to
  `src/controllers/v2/monitor-admin.ts` and wire the routes — the
  controller logic is already in the dist artifact but the source
  needs to be re-typed and registered in `routes/v2.ts`.
- Add an OIDC auth layer that hydrates `req.auth.team_id` and
  verifies the `admin` role server-side; the panel currently passes
  `X-Admin-Role: admin` as a placeholder.
- Build the diff viewer and claim button UIs (the wrappers are
  already typed in `lib/api.ts`).
