# Firecrawl Grafana Dashboards

This directory contains Grafana dashboards for the Firecrawl API.

## Status: Foundation

These dashboards are a **foundation** shipped against the existing
`/metrics` endpoint. They are not production-tuned. See
[`.audit/recursive-ultracode/RECOMMENDATIONS.md`](../../.audit/recursive-ultracode/RECOMMENDATIONS.md)
item **#19 (T2.1)** for the full roadmap item, and
[`docs/ROADMAP_2026.md`](../../docs/ROADMAP_2026.md) Tier 2 for the
multi-week production-tuning plan.

## What's shipped

| Dashboard | UID | Panels | Notes |
| --- | --- | --- | --- |
| `firecrawl-sli-slo.json` | `firecrawl-sli-slo-foundation` | 4 | SLI/SLO foundation: scrape p50, scrape p95, error rate, queue depth |

## How to import

1. Open Grafana → **Dashboards** → **New** → **Import**.
2. Upload `firecrawl-sli-slo.json`, or paste the JSON.
3. When prompted, select your Prometheus datasource (the dashboard
   uses a template variable `${DS_PROMETHEUS}` so you can swap it
   without editing the JSON).

### Scrape config

The dashboards expect the Firecrawl `/metrics` endpoint scraped by
Prometheus. A minimal job entry:

```yaml
scrape_configs:
  - job_name: firecrawl-api
    # New (admin-ops-07): the unauthenticated /metrics path is gated on its
    # own shared secret (METRICS_AUTH_KEY, min 16 chars). Unset -> 404.
    # The legacy /admin/${BULL_AUTH_KEY}/metrics path still works and
    # returns the same payload, but new scrapers should use /metrics so
    # that the scraper does not share credentials with the bull-board UI
    # and the destructive acuc-cache-clear endpoint.
    metrics_path: /metrics
    static_configs:
      - targets: ["firecrawl-api:3002"]
    bearer_token: ${METRICS_AUTH_KEY}

  - job_name: firecrawl-nuq-prefetch  # nuq pool gauges only
    metrics_path: /metrics
    static_configs:
      - targets: ["nuq-prefetch-worker:3007"]
```

The primary `/metrics` (and legacy `/admin/:BULL_AUTH_KEY/metrics`)
endpoint exposes `concurrency_limit_queue_job_count_total`,
`nuq_queue_scrape_job_count`, `http_request_duration_seconds`,
`job_duration_seconds`, and the fire-pdf + index-cache counters. See
`apps/api/src/controllers/v0/admin/metrics.ts` for the full list and
**Metric provenance** below for the file/line each metric comes from.

## Metric provenance

Which controller emits which gauge, and where the prom text is served
(`/metrics`, gated on `METRICS_AUTH_KEY`; the legacy
`/admin/:BULL_AUTH_KEY/metrics` path shares the same handler).

| Panel | PromQL metric | Source |
| --- | --- | --- |
| Scrape p50 / p95 | `http_request_duration_seconds` | `apps/api/src/lib/http-metrics.ts` (labels: `version`, `method`, `route`, `status`) |
| Error rate (5xx) | `http_request_duration_seconds_count` (5xx numerator / total denominator) | same |
| Queue depth (concurrency-limit) | `concurrency_limit_queue_job_count_total` | `apps/api/src/controllers/v0/admin/metrics.ts` (`metricsController`, lines 7–49) — computed from Redis `concurrency-limit-queues` set + per-team `zcard` |
| Queue depth (nuq scrape) | `nuq_queue_scrape_job_count` (labels: `status=queued`, `status=active`) | `apps/api/src/services/worker/nuq.ts` (`getMetrics()`, surfaced by `nuqGetLocalMetrics()` in the same controller) |
| Concurrent team semaphore | `team_concurrency_*` (per-team in-flight / max gauges) | `apps/api/src/services/worker/team-semaphore.ts` (`teamConcurrencySemaphore.getMetrics()`) |
| Billed teams | `billed_teams_count` | `apps/api/src/controllers/v0/admin/metrics.ts` — `SCARD billed_teams` |
| NUQ worker gauges (separate endpoint) | `nuq_pool_*`, `nuq_queue_*` | `apps/api/src/services/worker/nuq-router.ts` (`scrapeQueue.getMetrics()`) — mounted at `/metrics/nuq` |
| Job duration (fire-pdf / index-cache / scrape) | `job_duration_seconds_*` | `apps/api/src/lib/http-metrics.ts` and per-job instrumentation in `apps/api/src/services/worker/` |

The `route` label on `http_request_duration_seconds` is the matched
Express route pattern (e.g. `/scrape`, `/crawl/:jobId`), not the full
URL — see `getRoutePattern()` in `lib/http-metrics.ts`. The dashboard
PromQL filters accordingly.

## What's NOT shipped (deferred)

These are intentionally out of scope for the foundation; the
production-tuning effort is multi-week:

- **SLO targets / error-budget burn alerts.** Thresholds in the
  foundation panels are placeholders (green/yellow/red bands) — the
  real SLO numbers (e.g. "scrape p99 < 30s for 99% of requests over
  30 days") need a stakeholder review.
- **Per-team SLOs.** Tier 3.1 (per-team rate limits) is recent;
  per-team error budgets are blocked on that settling.
- **Multi-window burn-rate alerts.** Standard SRE practice
  (1h/6h/24h/3d windows) — needs the SLO targets first.
- **Crawl, extract, batch-scrape breakdowns.** Foundation lumps them
  together via the route regex; production should split them.
- **Worker / pool gauges.** `nuq_pool_waiting_count`,
  `nuq_pool_idle_count`, `nuq_pool_total_count` are exposed by
  `nuq-prefetch-worker` and could be a 5th panel.
- **Distributed tracing bridge.** Item **#20 (T2.2)** in the
  recommendations doc.
- **Runbook links & per-panel documentation.** Operator-facing
  runbooks are a separate effort.

## Schema version

Grafana `schemaVersion: 38` (Grafana 10.x). The JSON imports cleanly
on Grafana 10.0.0 and later.
