# Firecrawl Helm chart (T1.2 foundation)

This chart is the **foundation** for the T1.2 production-grade selenoid
cluster followup. It currently ships:

- A `selenoid` subchart with **one size preset** (`small` — 2 replicas).
- A `browsers.json` ConfigMap pre-populated with Chromium / Firefox / Opera.
- A ClusterIP Service exposing the W3C WebDriver endpoint on port 4444.
- A ReadWriteMany PVC for shared video/logs.

## What is intentionally NOT here (multi-week T1.2 followups)

- `HorizontalPodAutoscaler` on a custom `active_pages` metric. The
  Prometheus scrape annotation is wired in the Deployment, but the
  ServiceMonitor + HPA wiring is left to the operator.
- Multi-AZ pod anti-affinity / topology spread constraints.
- Browser image pull-through cache (air-gapped clusters should mirror
  the `selenoid/vnc:*` images and override `selenoid.image.registry`).
- Per-browser pod pinning, VNC by default, session quota enforcement.
- A real `api` / `worker` / `redis` / `rabbitmq` / `postgres` subchart.
  Those live in their own workstreams and are backfilled in a separate
  PR. The `api` block in `values.yaml` is a placeholder for the env vars
  the API pod needs to talk to selenoid.

## Install

```bash
helm install firecrawl ./charts/firecrawl \
  --set selenoid.enabled=true \
  --set selenoid.sizePreset=small
```

The chart is **disabled by default** — the standard self-host compose
profile uses the in-process Playwright pool and does not need a grid.

## Smoke test

```bash
kubectl port-forward svc/firecrawl-selenoid 4444:4444
curl -s http://localhost:4444/ping
# -> selenoid: ready
```

Then point a Firecrawl API pod at the grid:

```bash
export PLAYWRIGHT_DRIVER=webdriver
export WEBDRIVER_URL=http://firecrawl-selenoid:4444
```
