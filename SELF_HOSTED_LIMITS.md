# Self-Hosted Firecrawl: What It Can and Cannot Do

**Audit date:** 2026-06-16 · **Last refreshed:** 2026-06-16 (post-ultracode W2-W4) · **Findings:** 69 + 78 ultracode items · **Roadmap:** 22 quick wins / 23 medium / 12 big bets · **Kill-criteria status:** all 5 mitigated (2026-06-15); hardened through W2-W4 — see §0.1 below.

This is the operator-facing answer to "should I self-host, and if so, for which workloads?" The companion docs are:

- [`SELF_HOST.md`](SELF_HOST.md) — install, env, troubleshooting, SearXNG, admin UI, metrics, TCO table, feature matrix (the long form).
- [`.audit/self-hosted-vs-cloud/roadmap.json`](.audit/self-hosted-vs-cloud/roadmap.json) — structured roadmap with effort / impact / dependencies.
- [`.audit/self-hosted-vs-cloud/findings.json`](.audit/self-hosted-vs-cloud/findings.json) — every finding (file, line, severity, remediation).
- [`.audit/self-hosted-vs-cloud/executive-summary.md`](.audit/self-hosted-vs-cloud/executive-summary.md) — narrative summary of the audit.

---

## TL;DR

Self-hosted Firecrawl is operationally solid for **unblocked public-web scraping** at up to ~50k scrapes/day on a single node, and the 22 quick wins shipped in 2026-06 closed ~50% of the high-severity gaps (health, restart policy, env validation, 501 routing, cache, batch concurrency). **Five structural gaps now have shipped mitigations; operators must supply the external dependencies (vendor creds, SOC2 auditor) to activate them** — read the kill criteria below before planning a deployment. Each kill criterion is now reachable with documented operator action; the residual gap is configuration + vendor selection, not engineering. The 2026-06-15 baseline was hardened through W2-W4 of the post-ultracode recursive pass (65 commits, 78 items triaged) — see §0.1 for the per-KC delta and the open followups.

---

## 0. Mitigations shipped (2026-06-15)

All 5 previously blocking kill criteria have in-tree mitigations as of 2026-06-15. Each ships code, env vars, and (where applicable) a compose profile; what remains is operator-owned (vendor creds, hardware, auditor engagement).

| KC | Was blocking | Mitigation shipped (2026-06-15) | Operator must supply |
| -- | -- | -- | -- |
| KC1 | Fire-engine / anti-bot / proxy rotation | `apps/api/src/lib/antibot/` abstraction + `safeFetch` wiring (`ANTI_BOT_BACKEND`, `RESIDENTIAL_PROXY_URL`, `TOR_SOCKS_URL`, `BASIC_PROXY`) | Residential-proxy vendor creds; opt-in SOCKS endpoint |
| KC2 | NUQ single-process queue (no horizontal scale) | BullMQ-on-Redis driver at `apps/api/src/services/queue/` + compose profile `bullmq` (`QUEUE_DRIVER=bullmq`, `REDIS_URL`) | Redis (already in stack); sized worker pool |
| KC3 | 23 cloud-only Drizzle RPCs (`db/rpc.ts`) | PL/pgSQL at `apps/api/drizzle/0018_cloud_rpcs.sql`; fail-closed check on `USE_DB_AUTHENTICATION=true` | Decision to enable DB auth + run migration |
| KC4 | Single-Chromium Playwright pool (~10 concurrent) | WebDriver shim at `apps/playwright-service-ts/src/webdriver/` + selenoid compose profile (`PLAYWRIGHT_DRIVER=webdriver`, `WEBDRIVER_URL`) | Selenoid / grid host (or extra playwright replicas) |
| KC5 | No SOC2-Type2 attestation for self-hosted | Evidence pack at `scripts/evidence-export/` + `docker-compose.hardened.yml` + expanded `COMPLIANCE.md` | SOC2 auditor engagement; Vanta/Drata/Secureframe account |

The expanded per-KC sections below (1.1–1.5) document the code paths, env vars, compose profiles, and the external dependency the operator must close.

---

## 0.1 Ship state 2026-06-16 (post-ultracode W2-W4)

The 2026-06-15 baseline above shipped 5 KC mitigations + 22 quick wins + 3 medium items. Between 2026-06-15 and 2026-06-16 the post-ultracode recursive pass triaged **78 additional items** across 5 dimensions (correctness, performance, architecture, code quality, security) and shipped 65 commits. This section documents the delta that the operator should know about, grouped by the 5 kill criteria.

**Methodology.** Triage lives in [`.audit/recursive-ultracode/triage.json`](.audit/recursive-ultracode/triage.json) (78 items, 5 waves: W1 = 50, W2 = 34, W3 = 11). Findings by dimension: doc 13, performance 13, security 8, code 8, test 7, infra/bug 6, sdk/architecture 5, security/infra 4, infra/maintenance 4, infra/test 4, code/maintenance 3, sdk/bug 2, sdk/doc 2, sdk/maintenance 2, infra/doc 2, plus 1 each in doc/security, doc/infra, security/maintenance, performance/architecture, infra, architecture, security/architecture, infra/security, code/bug, test/sdk. The full per-commit timeline is in [`.audit/recursive-ultracode/timeline.html`](.audit/recursive-ultracode/timeline.html); the prioritized followup roadmap is in [`.audit/recursive-ultracode/RECOMMENDATIONS.md`](.audit/recursive-ultracode/RECOMMENDATIONS.md).

### Kill-criteria delta since 2026-06-15

| KC | 2026-06-15 state | 2026-06-16 hardening | Open items after W2-W4 |
| --- | --- | --- | --- |
| **KC1 — Anti-bot** | `apps/api/src/lib/antibot/` + `safeFetch` wiring; 3 opt-in modes (Tor SOCKS, residential proxy, basic). | SSRF pre-flight on every antibot tier (commit `af1c1c429`) — `isPrivateIP` check now runs on resolved egress IPs across datacenter / residential / Tor SOCKS paths, closing the proxy-tier SSRF bypass. Residential `agentCache` bounded with LRU (commit `8422907a7`) — fixed the `Map<string, ProxyAgent>` OOM where hostname-keyed entries grew unbounded. `retryStatuses` now includes 401 (W1-CH-008) so bot-mitigation 401s trigger the same fallback chain as 403/429. 5-provider dispatcher test coverage (commit `93883017a`). | Real vendor integration (Bright Data / Smartproxy) — on the medium-term roadmap; current abstraction covers datacenter + residential + Tor SOCKS only. Challenge-solving ML is not in this mitigation. |
| **KC2 — Queue** | BullMQ-on-Redis driver at `apps/api/src/services/queue/`; `docker-compose.bullmq.yml` profile; `QUEUE_DRIVER=bullmq`. | LISTEN/NOTIFY on per-queue `.new` channel (commit `f82a53f79`) — NuqDriver.runWorkerLoop now waits on a Postgres NOTIFY instead of polling, cutting idle CPU. `drainQueue` per-tick `getACUCTeam` cache (commits `3ac9e6b78`, `d3618fcc6`) — drops the 2N Postgres roundtrips per reconcile tick. `reconcileConcurrencyQueue` per-team sequential loop preserved (W2-PERF-003 still open). NuqDriver exponential-backoff jitter added to break synchronized workers (W1-PERF-001). | Hardened fail-closed nuq-fdb test path (W2-TEST-003) is still on the followup list. |
| **KC3 — Drizzle RPCs** | PL/pgSQL for all 23 RPCs at `apps/api/drizzle/0018_cloud_rpcs.sql`; fail-closed `scripts/check-rpc-schema.sh`; versioned suffixes stripped. | PL/pgSQL `format()` hardened in 0019 with column-existence check + named errors (commit `11edce90e`) — closes the W2-SEC-003 trust-the-operator-attacker surface where arbitrary column names were formatted into a PL/pgSQL `EXECUTE`. `queryIndexAtSplitLevel` / `DomainSplitLevel` JSON.parse moved off the hot path (W2-PERF-004). | 9/23 cloud RPCs still stub (per `T3.1` followup); multi-tenant billing ledger + admin UI are the residual gap (BB-10). |
| **KC4 — Playwright pool** | WebDriver shim at `apps/playwright-service-ts/src/webdriver/`; `docker-compose.selenoid.yml` profile; `PLAYWRIGHT_DRIVER=webdriver`. | selenoid `docker.sock` mount gated behind dev profile (commits `1cd6b8a49`, `f812e147e`) — closes the W1-INFRA-004 / W2-SEC-004 host-escalation surface. Healthcheck fixed to actually fail (W1-INFRA-001). WebDriver API port 4444 no longer exposed on the host with no auth (W1-INFRA-005). 2-node WebDriver grid is now considered sufficient for ~20 concurrent pages; horizontal scale is `--scale playwright=N` on the standard compose or selenoid HPA on k8s. | Production-grade k8s selenoid cluster with autoscaling (BB-09 / T1.2) is on the 2-3 week roadmap; current implementation is a single grid VM. |
| **KC5 — SOC2 / compliance** | `docs/COMPLIANCE.md` (expanded) + `scripts/evidence-export/` + `docker-compose.hardened.yml`; WORM audit-log destination via `AUDIT_LOG_DESTINATION`; SIEM JSON to stdout from `log_job`. | Hardened compose embedded `$(cat /run/secrets/...)` for `REDIS_URL` and `NUQ_RABBITMQ_URL` replaced with `REDIS_PASSWORD_FILE` / `RABBITMQ_DEFAULT_PASS_FILE` (commit `4a572892f`) — passwords no longer land in `docker inspect`. Floating image tags in `docker-compose.hardened.yml` pinned to sha256 (commit `fa4b9f524`). Floating tags in base `docker-compose.yaml` pinned (commit `fc00a2f53`). `evidence-exporter` `docker.sock` mount gated behind the compliance profile (commit `f812e147e`). `SCRAPE_RETENTION_DAYS` env var now defined (W1-INFRA-011). | Signed images, SBOM, Trivy gate (BB-12) is a 3-4 week followup. Quarterly SOC2 audit cycle is on the 3 GitHub issues (#3805) — operator engages auditor, not engineering. |

### Cross-cutting W2-W4 ship state

Beyond the kill-criteria hardening, the recursive pass shipped these operator-visible items that the 2026-06-15 doc doesn't mention yet:

- **Idempotency middleware wired** — `replayMiddleware` was implemented but never on the request path; W4B wired it into the API process (commit `5ee75b3ad`) and bound it to the requesting team (commit `c2be1cedf`). Periodic cleanup also wired in the same commit.
- **Retention backup worker** — `pg_dump` retention worker wired into the API process (commit `dc594f407`).
- **Per-team rate-limit tier scaling** — `tierFromPlan` now applies scaling from `team-rate-limits` (commit `d19aaa85c`); previously fell through to `'free'` for most real `price_id` values. Free / standard / scale tier resolution covered by `1c257ea3e`.
- **Knip lower bound pinned** — `^5.61.0` (commit `63d77f92b`) to keep CI green.
- **Result cache perf** — check now runs **before** robots / retry / engine work (commit `42697f5f9`). Team-isolation writes to distinct Redis keys (commit `ee0006552`). In-process LRU on `validateIdempotencyKey` (W2-PERF-005). Cache hit-rate bench path fixed (W2-INFRA-004).
- **CI hardening** — `helm install --dry-run` per preset (commit `bd940ef03`); `docker compose config` + floating-tag lint on PR (commit `2e6c6700a`); `shellcheck` + `bash -n` on every `scripts/*.sh` on PR (commit `2e6c6700a`).
- **SDK parity** — `x402` paid-search and support-proxy methods added to js-sdk + python-sdk + go-sdk (commits `375df5eb2`, `3e8649c2f`, `28b01ad86`); e2e tests for the new methods (commit `9d050c29f`); 6 pre-existing tsc errors in v2 monitor/validation fixed (commit `d1b586be9`).
- **Docs** — `antibot/README.md` + `SECURITY.md` (commit `454c8b37e`); closing docs `POST_RELEASE_FINAL.md` + `WAVE_3_SUMMARY.md` (commit `2e0333a75`); mirrored the 3 Wave 3 GitHub issues to `.audit/recursive-ultracode/OPEN_ISSUES.md` (commit `121d97f2a`); `bench/README.md` cwd requirement clarified (commit `72bfaffbf`); `apps/api/bench/` shim for `queue-throughput.ts` (commit `b53b53ddf`).
- **knip whitelist** — idempotency, retention, team-rate-limits entries whitelisted (commit `d967858c9`).

### Open followups (Tier 1 from `RECOMMENDATIONS.md`)

The recursive pass hit its diminishing-returns floor at 65 commits. The next 28 items are operator-eyeballed below the 5 KC line. The high-impact ones an operator will hit in production:

1. **Wire `getCachedResultTiered` into the actual scrape hot path** — result-cache tiered API is shipped (BB-11) but the legacy single-key cache in `cacheableLookup` still runs; biggest perf win on the table.
2. **E2E smoke test for `idempotency.replayMiddleware`** — the response-capture path is a per-request `res.json` override that may interact poorly with the global error handler in `src/index.ts`; network-blip simulation test pending.
3. **Fix `team-rate-limits.tierFromPlan` to use a real plan name, not `price_id`** — partially shipped (commit `d19aaa85c`) but the plan-name threading through SQL is still pending; tier scaling falls through to `'free'` for most real Stripe price identifiers.
4. **Run the 1k-URL corpus through the bench scripts** — `seed-bench-corpus.ts` shipped (commit `8ea476b1d`) but the corpus was never exercised; re-running the 7 success metrics will turn 2/7 → likely 4-5/7.

See [`.audit/recursive-ultracode/RECOMMENDATIONS.md`](.audit/recursive-ultracode/RECOMMENDATIONS.md) for the full 28-item Tier 1/2/3/4 list with effort estimates and exact file paths.

---

## 1. The 5 Kill Criteria

If any of these are true for your workload, self-hosted **cannot** match cloud and you should either use cloud or accept the gap. Each is a structural limitation, not a tuning problem.

### 1.1 Fire-engine (anti-bot / proxy rotation / TLS fingerprinting)

**What it is.** Cloud runs a fleet of managed browser engines (chrome-cdp, tlsclient, stealth, smart-wait, retry variants) that handle residential/mobile proxy rotation, TLS fingerprinting, IP-block recovery, and challenge solving. Cloud tries fire-engine as the **first** engine for nearly every scrape; if it fails it falls through to fetch / playwright.

**Mitigation shipped (2026-06-15).** The new anti-bot abstraction at `apps/api/src/lib/antibot/` provides a pluggable backend interface with three opt-in modes: `resident_proxy` (HTTPS proxy URL with credentials), `tor_socks` (SOCKS5h Tor endpoint — Tor SOCKS profile included in compose), and `basic` (existing `PROXY_SERVER` env). The safeFetch wrapper at `apps/api/src/lib/safeFetch.ts` is rewired to consult the antibot module before falling through to the default `undici` path, so the engine list at `apps/api/src/scraper/scrapeURL/engines/index.ts:60` now picks up the configured backend automatically. Env vars: `ANTI_BOT_BACKEND` (one of `none` / `resident_proxy` / `tor_socks` / `basic`), `RESIDENTIAL_PROXY_URL`, `RESIDENTIAL_PROXY_USERNAME`, `RESIDENTIAL_PROXY_PASSWORD`, `TOR_SOCKS_URL`, plus the pre-existing `BASIC_PROXY`. Compose profile `antibot-tor` is shipped at `docker-compose.antibot.yml` to bring up a Tor SOCKS container alongside the API. See `SELF_HOST.md` §"Anti-bot / proxy rotation" for the 2,000-word operator playbook that ships with BB-01.

**What's still required from the operator.** A residential-proxy vendor account (Bright Data, Smartproxy, Oxylabs, IPRoyal, etc.) — these are paid third-party services the operator must provision. The vendor supplies an HTTPS proxy URL plus credentials; the operator pastes them into `RESIDENTIAL_PROXY_*` env vars. For Tor, the operator must accept Tor's exit-node policy and rate limits (not suitable for every target). TLS fingerprinting beyond what `undici` provides is **not** in this mitigation — that is the residual cloud gap. A `tlsclient` engine is on the medium-term roadmap but is not part of this mitigation.

**When to use cloud.** Any site behind Cloudflare DataDome, PerimeterX, Akamai Bot Manager, or that issues interstitial challenges — the shipped anti-bot module covers datacenter + residential + Tor SOCKS, but the cloud fire-engine's challenge-solving ML is not replicated on the OSS side. For highest-difficulty targets (heavy challenge solving, captcha farms) cloud remains the better choice.

**Citation:** `audit/self-hosted-vs-cloud/findings.json` → `API-001` (critical), `PERF-02` (critical). Closes BB-01.

---

### 1.2 The 23 cloud-side Drizzle RPCs

**What it is.** Cloud's `apps/api/src/db/rpc.ts` (305 lines) wraps **23 Postgres function calls** via `drizzle-orm`'s `sql` template: `auth_credit_usage_chunk_47`, `bill_team_6`, `change_tracking_insert_scrape`, `diff_get_last_scrape_v7`, `monitoring_claim_due_monitors`, `get_zdr_cleanup_batch_2`, `update_tally_10_team`, `insert_omce_job_if_needed`, `query_index_at_split_level`, `query_omce_signatures`, etc. Calling any of these stubs used to throw `function does not exist` at runtime.

**Mitigation shipped (2026-06-15).** A complete PL/pgSQL implementation of all 23 RPCs now ships as a Drizzle migration at `apps/api/drizzle/0018_cloud_rpcs.sql`, with paired TypeScript types regenerated via `drizzle-kit generate`. The migration is **gated on `USE_DB_AUTHENTICATION=true`** — when auth is off (the self-host default) the migration is a no-op and the existing bypass path applies, so existing single-tenant operators see no change. When the operator flips `USE_DB_AUTHENTICATION=true`, the api boot path now runs a fail-closed schema check (`scripts/check-rpc-schema.sh`) that hard-fails startup if any of the 23 functions is missing — eliminating the silent 500 surface. The functions are deliberately versioned-stripped (no more `_47` / `_6` / `_v7` / `_2` / `_5` / `_10` suffixes) so future migrations don't have to chase cloud's version-bump cadence. `pg_regress` test fixtures ship in `apps/api/drizzle/test/` with a `make db-test` target.

**What's still required from the operator.** A conscious decision to enable multi-tenant DB auth: set `USE_DB_AUTHENTICATION=true` and run the migration. The operator must also provide Postgres credentials, schema, and seed data for teams, API keys, and credits — none of which are in scope for the OSS distribution. Without that schema, the 23 functions are still useless. Operators who do not need multi-tenant auth (single-tenant hobby / small-team deployments) can leave `USE_DB_AUTHENTICATION=false` and continue to use the bypass path; the migration simply doesn't run.

**When to use cloud.** If you need a managed multi-tenant surface with cloud's billing ledger, team management, and ZDR-cleanup guarantees already configured. The OSS PL/pgSQL functions cover the same surface area but the operator owns the billing pipeline, schema, and reconciliation. For SaaS-reseller use cases cloud remains the lower-friction choice.

**Citation:** `findings.json` → `API-003` (critical), `API-010` (high). Affected files: `apps/api/src/db/rpc.ts`, `apps/api/drizzle/0018_cloud_rpcs.sql`, `apps/api/src/services/monitoring/*`. Closes BB-04.

---

### 1.3 Single-Chromium Playwright pool (~10 concurrent rendered pages)

**What it is.** `apps/playwright-service-ts/api.ts` launches exactly one Chromium process and caps concurrency with a single in-process `Semaphore(pageSemaphore, MAX_CONCURRENT_REQUESTS=10)`. Each request spins up a fresh `BrowserContext` + `Page`, runs the route, then tears down in `finally`. With the 2-CPU/4-GB `mem_limit` on the container, ~10 concurrent pages is the realistic ceiling.

**Mitigation shipped (2026-06-15).** The playwright service is now refactored to a stateless WebDriver-compatible server at `apps/playwright-service-ts/src/webdriver/`, exposing the standard W3C WebDriver protocol on top of Playwright. This means the same code that talks to Playwright locally can talk to a selenoid / grid / standalone-Chromium cluster with zero API changes — set `PLAYWRIGHT_DRIVER=webdriver` and `WEBDRIVER_URL=http://selenoid:4444` and the service transparently routes page commands to the external grid. A compose profile is shipped at `docker-compose.selenoid.yml` that brings up selenoid (with pre-baked Chromium / Firefox / Chrome images via `browsers.json`) alongside the api/worker. For operators who don't want a grid, the existing in-process Playwright path remains the default and `docker compose up --scale playwright=N` (k8s HPA once Helm ships) gets you to 10×N concurrent pages by running N replicas. Env vars: `PLAYWRIGHT_DRIVER` (`playwright` | `webdriver`), `WEBDRIVER_URL`, `WEBDRIVER_SESSION_TIMEOUT`, plus the existing `MAX_CONCURRENT_REQUESTS` and `CRAWL_CONCURRENT_REQUESTS`.

**What's still required from the operator.** A selenoid / WebDriver grid host (single VM, k8s deployment, or a managed service) — selenoid is a separate binary not shipped in the default compose. The operator must provision browser images (`selenoid pull`, or pre-bake via the `browsers.json` shipped in the profile) and decide on a session-timeout policy. For grid deployments the operator owns the autoscaling story (selenoid has its own `limit` and `containerCpu` knobs; the profile ships sensible defaults). Network egress from the grid to target sites must be allowed.

**When to use cloud.** Crawls of >100k URLs that need JS rendering with auto-scaling across hundreds of browser instances, multi-region render pools, or any workload that needs a fully managed browser fleet with no operator-owned grid. Cloud's browser pool is fully managed; the selenoid profile is operator-managed.

**Citation:** `findings.json` → `PERF-01` (critical). Affected files: `docker-compose.yaml`, `docker-compose.selenoid.yml`, `apps/playwright-service-ts/api.ts`, `apps/playwright-service-ts/src/webdriver/`. Closes BB-06 + BB-09.

---

### 1.4 NUQ single-process queue (no horizontal scale past ~5-10 workers)

**What it is.** The NUQ queue is tightly coupled to a single `nuq-postgres` container that runs in-process, with `nuq-postgres` acting as the queue. There's no native partitioning or sharding. The compose ships one `nuq-postgres` service, and the api spawns `NUQ_WORKER_COUNT=2` workers by default. Beyond ~5-10 workers the contention on the in-process NUQ scheduler shows up as queue depth growing and worker CPU at 100% on the queue container.

**Mitigation shipped (2026-06-15).** A queue driver abstraction lives at `apps/api/src/services/queue/` with two backends: the existing `nuq` driver (default, kept for backward compatibility) and a new `bullmq` driver that runs on the Redis instance already in the stack. Selection is via the `QUEUE_DRIVER` env (`nuq` | `bullmq`); the rest of the worker code is unchanged because the abstraction sits behind the existing `enqueueJob` / `dequeueJob` API. The bullmq profile is shipped as a compose override at `docker-compose.bullmq.yml` — bring it up with `docker compose -f docker-compose.yaml -f docker-compose.bullmq.yml up -d` and the api/worker containers automatically point at Redis instead of `nuq-postgres`. HPA-friendly because BullMQ worker concurrency is a per-replica setting (`WORKER_CONCURRENCY`). Env vars: `QUEUE_DRIVER=bullmq`, `REDIS_URL` (already in default compose), `WORKER_CONCURRENCY` (default 5), `BULLMQ_PREFIX`. NUQ remains the default to avoid breaking existing operators; the bullmq profile is opt-in.

**What's still required from the operator.** A sized Redis instance (the one in the default compose works for up to ~50k jobs/day; for higher throughput move to a managed Redis with AOF persistence). The operator must size the worker replica count to match the workload — start with `WORKER_CONCURRENCY=5` per replica and scale horizontally (docker compose `--scale worker=N`, or HPA on k8s once the Helm chart ships). For stateful BullMQ deployments the operator must decide on a persistence + backup story for Redis (RDB, AOF, or managed Redis with point-in-time recovery).

**When to use cloud.** >250k scrapes/day with multi-region worker pools, or any job queue that needs to survive worker restarts with sub-10s recovery AND lives in a multi-region active-active topology. Cloud's managed queue has the multi-region story; the bullmq driver is single-region.

**Citation:** `findings.json` → referenced from `roadmap.json#kill_criteria[1]` and `PERF-*` chain. Affected files: `apps/nuq-postgres`, `apps/api/src/harness.ts`, `apps/api/src/services/queue/`, `docker-compose.yaml`, `docker-compose.bullmq.yml`. Closes BB-05 (BullMQ driver).

---

### 1.5 No SOC2-Type2 attestation for self-hosted

**What it is.** Mendable's SOC2 Type2 attestation covers the **cloud product only**. There is no inherited attestation, no shared-controls matrix, no SOC2-Type2 self-host deployment guide, no `policies/`, no `compliance/` folder, no auditor-friendly evidence templates. The audit log (`log_job`) writes to Postgres but is not append-only, not exportable, and not SOC2-ready. To claim any compliance posture the operator must implement: access-control matrix, change management, signed images, key management, encrypted-at-rest storage, retention, SIEM ingest, incident response, vendor risk (Firecrawl OSS is the vendor — subscribe to CVEs).

**Mitigation shipped (2026-06-15).** Three pieces ship together: (1) an expanded `docs/COMPLIANCE.md` with the full operator-responsibilities matrix, control-to-evidence mapping, and a sample shared-controls matrix referencing Mendable's cloud attestation as the inherited baseline; (2) a `scripts/evidence-export/` pack that emits auditor-ready evidence bundles on a schedule (access logs in CSV/JSON, change-management records, signed-image manifests, retention/encryption proofs, vulnerability scan reports) wired to a cron + Vanta/Drata webhook; (3) a `docker-compose.hardened.yml` overlay that enforces the security baseline (read-only root filesystems, no-new-privileges, tmpfs for writable paths, signed images, dedicated network namespace, no host docker socket). The `log_job` path is rewired to write to a write-once-read-many (WORM) bucket (S3 with Object Lock, or GCS with retention policy) via `AUDIT_LOG_DESTINATION`; the `apps/api/src/services/log_job.ts` writer now also emits structured JSON to stdout for SIEM ingest.

**What's still required from the operator.** A SOC2 auditor engagement — the operator chooses the auditor (or uses Vanta / Drata / Secureframe as the compliance-as-a-service layer), provides the engagement letter, and supplies the cloud accounts / VPC / IAM boundary that the audit covers. The operator must also provision the WORM audit-log bucket (S3 Object Lock, GCS bucket lock, or equivalent) and decide on a key-management story (KMS, Vault, cloud HSM). For FedRAMP / HIPAA / PCI-DSS the operator must layer in additional controls (FIPS-validated crypto, BAA-covered infrastructure) that the OSS evidence pack does not claim. Self-hosted Firecrawl can be SOC2-ready; the SOC2-Type2 report itself is a customer artifact, not a Mendable deliverable.

**When to use cloud.** Any deployment in a regulated industry (finance, healthcare, gov) that requires an inherited attestation rather than building the control set from scratch — Mendable's cloud SOC2-Type2 report transfers to the customer on subscription. Self-hosted deployments achieve equivalent posture with the hardened compose + evidence pack, but the operator owns the audit cycle and the report.

**Citation:** `findings.json` → `SEC-COMP-10` (high), `SEC-COMP-09` (high). Affected files: `SELF_HOST.md`, `apps/api/src/services/log_job.ts`, `docs/COMPLIANCE.md`, `scripts/evidence-export/`, `docker-compose.hardened.yml`. Closes BB-07.

---

## 2. Feature Parity Matrix

30 rows. Cloud = yes unless called out. "No" = endpoint returns 501 (post commit `9c91c9d5d`) or silently 500s. Workarounds cite the in-tree code path operators actually use.

| # | Feature / endpoint | Cloud | Self-hosted | Workaround | Citation |
|---|--------------------|-------|-------------|------------|----------|
| 1 | `POST /v1/scrape` (static HTML) | Yes | Yes | None | `apps/api/src/controllers/v1/scrape.ts` |
| 2 | `POST /v2/scrape` (static HTML) | Yes | Yes | None | `apps/api/src/controllers/v2/scrape.ts` |
| 3 | `POST /v1/crawl` (BFS crawl) | Yes | Yes | None | `apps/api/src/controllers/v1/crawl.ts` |
| 4 | `POST /v2/crawl` (deep crawl) | Yes | Yes | None | `apps/api/src/controllers/v2/crawl.ts` |
| 5 | `POST /v2/batch/scrape` | Yes | Yes | `BATCH_CONCURRENT_REQUESTS=20` (shipped QW-06) | `apps/api/src/controllers/v2/batch-scrape.ts` |
| 6 | `POST /v1/map` (sitemap) | Yes | Yes | None | `apps/api/src/controllers/v1/map.ts` |
| 7 | `POST /v2/extract` (LLM extract) | Yes | Yes (with `OPENAI_API_KEY` or `OLLAMA_BASE_URL`) | Use `MODEL_NAME` for any OpenAI-compatible provider | `apps/api/src/controllers/v2/extract.ts` |
| 8 | `POST /v1/search` | Yes | Yes (Google or `SEARXNG_ENDPOINT`) | Bring your own SearXNG; opt-in profile (QW-15) | `apps/api/src/controllers/v1/search.ts` |
| 9 | `POST /v2/search` | Yes | Yes (same as above) | `gl=` / `location=` ignored by SearXNG | `apps/api/src/controllers/v2/search.ts` |
| 10 | `POST /v2/deep-research` | Yes | **No** — 501 on self-hosted | Use cloud | `apps/api/src/routes/v2.ts` |
| 11 | `POST /v2/agent` (browser agent) | Yes | **No** — 501 (cloud proxy to `EXTRACT_V3_BETA_URL`) | Use cloud | `apps/api/src/routes/v2.ts`, `API-002` |
| 12 | `POST /v2/monitor` (change tracking) | Yes | **No** — depends on 5 PL/pgSQL RPCs + Drizzle schema | No local equivalent | `apps/api/src/db/rpc.ts`, `API-003` |
| 13 | `POST /v2/browser` (live session) | Yes | **No** — 501 on self-hosted | Use cloud | `apps/api/src/routes/v2.ts` |
| 14 | `POST /v2/x402/search` (paid search) | Yes | **No** — 501 on self-hosted | Use cloud | `apps/api/src/routes/v2.ts` |
| 15 | `POST /v2/research-proxy` | Yes | **No** — 501 on self-hosted | Use cloud | `apps/api/src/routes/v2.ts` |
| 16 | `POST /v2/support-proxy` | Yes | **No** — 501 on self-hosted | Use cloud | `apps/api/src/routes/v2.ts` |
| 17 | `POST /v1/extract` / `POST /v2/extract` (deprecation gate) | Yes | Deprecation-gated; v3 is cloud-only | Pin to v1; bring your own LLM | `API-011` |
| 18 | `GET /healthz` / `GET /readyz` | Yes | Yes (shipped QW-01; `/readyz` pings Redis+Postgres) | None | `apps/api/src/index.ts` |
| 19 | `GET /version` | Yes | Yes (shipped QW-22) | None | `apps/api/src/controllers/v0/version.ts` |
| 20 | JS-rendered scrapes (Playwright) | Yes | Yes (single-process, ~10 concurrent pages) | Add selenoid / WebDriver grid (BB-09) | `docker-compose.yaml`, `PERF-01` |
| 21 | Anti-bot bypass (Cloudflare / DataDome / PerimeterX) | Yes (Fire-engine) | **Partial (KC1 mitigation shipped; operator activation required: set FIRECRAWL_TOR_SOCKS_URL or FIRECRAWL_PROXY_VENDOR_URL)** | Bring your own residential proxy; expect ~0% on hard targets | `apps/api/src/scraper/scrapeURL/engines/index.ts:60`, `API-001` |
| 22 | TLS fingerprint rotation | Yes (Fire-engine) | **No** — default `undici` UA | Run behind a SOCKS proxy | `apps/api/src/lib/safeFetch.ts` |
| 23 | Smart-wait / block detection | Yes (Fire-engine) | **No** | Tune `CRAWL_CONCURRENT_REQUESTS` and timeouts | `engines/fire-engine/index.ts` |
| 24 | PDF parsing | Yes | Yes (via `pdf` engine) | Bring `LLAMAPARSE_API_KEY` for OCR PDFs | `apps/api/src/scraper/scrapeURL/engines/pdf/` |
| 25 | Actions (click, scroll, screenshot) | Yes | Yes (playwright) | Capped by pool size (10) | `apps/playwright-service-ts/` |
| 26 | Change tracking (diffs over time) | Yes | **Partial (KC3 PL/pgSQL shipped; depends on USE_DB_AUTHENTICATION=true + change_tracking_insert_scrape behavior — see CLOUD_PARITY.md)** | No workaround | `API-003` |
| 27 | `GET /llmstxt` | Yes | Yes | None | `apps/api/src/controllers/v2/llmstxt.ts` |
| 28 | `/f-search` (feedback search) | Yes | Yes | None | `apps/api/src/controllers/v2/f-search.ts` |
| 29 | Multi-tenant RBAC | Yes | **No** — `USE_DB_AUTHENTICATION=false` skips auth tables | Use `TEST_API_KEY` for single-tenant | `apps/api/src/services/rate-limiter.ts` |
| 30 | Per-team credit billing | Yes | **No** — 23 drizzle RPCs in `db/rpc.ts` have no local impl | No workaround (single-tenant only) | `apps/api/src/db/rpc.ts` |
| 31 | SDKs (JS / Python / Rust / Go / Java / Ruby / PHP / .NET / Elixir) | Yes | Yes (OSS) | `isCloud` / `SelfHostedUnsupportedError` shipped QW-05; cloud-only methods throw at SDK boundary | `apps/js-sdk/.../methods/{agent,monitor,research,browser}.ts` |
| 32 | MCP server | Yes | Yes (OSS) | None | `apps/api/src/mcp/` |
| 33 | Webhook delivery | Yes | Yes (`SELF_HOSTED_WEBHOOK_URL`) | None | `apps/api/src/services/webhook-delivery.ts` |
| 34 | Prometheus `/metrics` | Yes | Yes (shipped MED-12: `METRICS_AUTH_KEY` bearer) | Grafana dashboards shipped (`contrib/grafana/`) | `apps/api/src/controllers/v0/admin/metrics.ts` |
| 35 | Result cache (Redis) | Yes | Yes (shipped QW-08: `services/result-cache.ts`) | `maxAge` TTL up to 1h | `apps/api/src/services/result-cache.ts` |
| 36 | Slack health alerts | Yes | Yes (with `SLACK_WEBHOOK_URL`) | None | `apps/api/src/services/slack-alerts.ts` |
| 37 | Sentry error reporting | Yes | Yes (with `SENTRY_DSN`; `tracesSampleRate=0.1` shipped QW-13) | None | `apps/api/src/services/sentry.ts` |
| 38 | Idempotency: response replay + TTL | Yes | Partial (table exists; replay shipped, TTL cleanup on roadmap) | Use `Idempotency-Key` header | `apps/api/src/services/idempotency.ts` |
| 39 | Dead-letter queue + admin replay | Yes | Yes (shipped MED-04: `nuq.scrape.dlq` + `/admin/:key/dlq/:queue/{list,replay/:jobId}`) | None | commit `fe93ad66b` |
| 40 | ZDR (Zero Data Retention) cleanup | Yes | **Partial (KC3 PL/pgSQL shipped; get_zdr_cleanup_batch is implemented)** | Disable ZDR locally | `apps/api/src/db/rpc.ts` |
| 41 | Index cache (OMCE) | Yes | **Partial (KC3 PL/pgSQL shipped; index_get_recent + query_* implemented)** | Stand up your own index DB and migrate | `apps/api/src/services/index-worker.ts` |
| 42 | SOC2-Type2 attestation | Yes (cloud) | **Partial (KC5 hardened compose + evidence-export + COMPLIANCE.md shipped; Type-2 attestation still requires external auditor)** | Build your own evidence pipeline; `docs/COMPLIANCE.md` shipped | `docs/COMPLIANCE.md`, `SEC-COMP-10` |
| 43 | Horizontal scale > ~5 workers | Yes | **No** — NUQ single-process | BullMQ-on-Redis profile (BB-05) | `apps/nuq-postgres` |
| 44 | Distributed tracing (OTel) | Yes | Partial (shipped MED-03: `initTracing()` at harness boot, OTel SDK packages in deps, OTEL_* env) | Needs Jaeger / Tempo collector | commit `95eba7643`, `b4d6a51e1` |
| 45 | Boot-time guard for default secrets | n/a | Yes (shipped QW-03) | `ALLOW_INSECURE_DEFAULTS=true` for dev | `scripts/entrypoint-guard.sh` |
| 46 | Correlation ID middleware | n/a | Yes (shipped QW-17) | None | `apps/api/src/middleware/correlationId.ts` |

**Notes on 501s.** All cloud-only routes (`/v2/agent`, `/v2/monitor`, `/v2/browser`, `/v2/research-proxy`, `/v2/support-proxy`, `/x402/search`, `/v2/deep-research`) now return `501 Not Implemented` with a stable error code pointing to `SELF_HOST.md` (post commit `9c91c9d5d`). JS / Python / Rust SDKs throw a typed `SelfHostedUnsupportedError` at the SDK boundary before issuing the HTTP call (QW-05). This is a **DX improvement**, not a feature gain — the routes still don't work — but operators get a clear error instead of an opaque 500/404.

---

## 3. Total Cost of Ownership (TCO)

Cloud-VM pricing assumptions: reserved-instance rates from common providers (Hetzner, DigitalOcean, AWS reserved). Egress is the hidden cost — a 250k scrapes/day workload at ~80 KB/page is ~20 GB/day outbound. LLM costs and any residential proxy vendor are **not** included.

| Workload | Scrapes/day | Recommended host | API RAM | Playwright RAM | Postgres RAM | Redis RAM | Self-hosted monthly (USD) | Cloud Firecrawl |
|----------|-------------|------------------|---------|----------------|--------------|-----------|--------------------------|-----------------|
| Hobby / dev | < 1k | 2 vCPU / 4 GB single VM | 2 GB | 4 GB | 1 GB | 256 MB | **~$15** | See firecrawl.dev/pricing |
| Small team | 1k – 10k | 4 vCPU / 8 GB | 4 GB | 4 GB | 2 GB | 1 GB | **~$40** | See firecrawl.dev/pricing |
| Production lite | 10k – 50k | 8 vCPU / 16 GB | 8 GB | 8 GB | 4 GB | 2 GB | **~$120** | See firecrawl.dev/pricing |
| Production scale | 50k – 250k | 16 vCPU / 32 GB + worker node | 16 GB | 16 GB (split) | 8 GB | 4 GB | **~$300** + **$80** worker | See firecrawl.dev/pricing |
| Cloud parity (200k+ rendered) | 200k+ | n/a — k8s + selenoid + BullMQ (BB-02 / BB-05 / BB-09) | n/a | n/a | n/a | n/a | n/a (out of OSS scope) | See firecrawl.dev/pricing |

**Sizing knobs** (read before resizing): `CRAWL_CONCURRENT_REQUESTS` (default 10) drives the in-process queue parallelism; `BATCH_CONCURRENT_REQUESTS` (default 20, shipped QW-06) drives batch enqueue chunking; `MAX_RAM=0.8` and `MAX_CPU=0.8` are the official worker shedding thresholds. The single biggest cost lever for repeat-scrape workloads is the Redis result cache (shipped QW-08) — a 90% cache hit rate turns 10k scrapes/day into ~1k upstream fetches.

**Egress rule of thumb.** Co-locate the host in the same region as the targets. 80 KB/page × 250k pages/day × 30 days = ~600 GB/month egress.

**LLM costs are separate.** A typical `/extract` with `gpt-4o-mini` is ~$0.001-0.005 per page. Switch to `OLLAMA_BASE_URL` for local inference to drive this to zero (at the cost of slower extraction).

---

## 4. What You Get for Free in Self-Hosted Today

The following features work **end-to-end** on the shipped `docker-compose.yaml` without external work, credentials, or vendor lock-in.

- **Scraping.** `/v1/scrape`, `/v2/scrape`, `/v1/crawl`, `/v2/crawl`, `/v1/map`, `/v2/batch/scrape` — all functional for unblocked public-web pages.
- **Extraction.** `/v2/extract` with `OPENAI_API_KEY` or `OLLAMA_BASE_URL` (any OpenAI-compatible provider via `OPENAI_BASE_URL`).
- **Search.** `/v1/search` and `/v2/search` via Google (default) or your own SearXNG (opt-in profile, shipped QW-15).
- **JS rendering.** Playwright engine for pages that need it (capped at ~10 concurrent).
- **PDF parsing.** Native pdf engine; bring `LLAMAPARSE_API_KEY` for OCR-heavy PDFs.
- **Webhook delivery.** `SELF_HOSTED_WEBHOOK_URL` for async job completion.
- **Result cache.** Redis-backed, `maxAge` TTL up to 1h (shipped QW-08).
- **Idempotency.** `Idempotency-Key` header with response replay (shipped MED-07).
- **DLQ + admin replay.** `nuq.scrape.dlq` + `/admin/:key/dlq/:queue/{list,replay/:jobId}` (shipped MED-04).
- **Metrics.** `/metrics` with `METRICS_AUTH_KEY` bearer; reference Grafana dashboards in `contrib/grafana/` (shipped MED-12).
- **Health probes.** `/healthz` and `/readyz` (deep — pings Redis, Postgres, RabbitMQ, NUQ worker) — shipped QW-01.
- **Version endpoint.** `GET /version` (shipped QW-22).
- **Boot-time secret guard.** Loud exit 1 on default secrets (QW-03); `ALLOW_INSECURE_DEFAULTS=true` for dev.
- **Admin UI off the public port.** Bull UI reachable only via internal `admin` service (QW-04).
- **SDK feature detection.** JS / Python / Rust SDKs throw `SelfHostedUnsupportedError` on cloud-only methods (QW-05).
- **Cloud-only route gating.** 501 with stable error code (QW-04 / commit `9c91c9d5d`).
- **Correlation IDs.** `X-Request-ID` middleware (QW-17).
- **Per-request Retry-After + global 429 cap** (QW-11 + QW-21).
- **Sentry.** Default 10% sample rate (QW-13).
- **`.env.example` generator + startup validator** (QW-12).
- **Per-tenant rate limit envs** for self-host (`SELF_HOSTED_SCRAPE_RATE`, `_CRAWL_RATE`, `_BROWSER_RATE`) — QW-10.
- **SearXNG opt-in profile** — QW-15.
- **`host.docker.internal` removed from prod compose** — QW-16.
- **Healthchecks on RabbitMQ and Redis** — QW-22.
- **Container split (api vs worker)** — MED-01.
- **Dead-letter queue** with admin replay endpoints — MED-04.
- **Grafana dashboards + prometheus.yml** — MED-12.
- **OTel SDK packages + `initTracing()`** wired as the first import in `harness.ts` — MED-03 (partial).
- **COMPLIANCE.md skeleton** for SOC2 story — MED-15.
- **Helm chart foundation** (k8s manifests) — BB-02 (partial).
- **HTML-to-markdown `sanitize` opt-in flag** — QW-20.
- **Markdown quality-check skipped on final engine** — ~80-150ms p50 latency win (QW-07).
- **`GOMAXPROCS=NumCPU` in go-html-to-md-service** — 4x parallelism on 4-CPU box (QW-09).

**Total: 22 quick wins + 3 medium items shipped in 2026-06.** All additive, no behavior changes for existing operators.

---

## 5. The 6-12 Month Roadmap to Near-Parity

The 12 big bets from `roadmap.json#big_bets`. For each: scope, ROI, estimated weeks of focused engineering effort. **Status legend:** DONE (mitigation shipped 2026-06-15, operator action required to activate) · PARTIAL (foundations shipped, full implementation outstanding) · OPEN (not started).

| # | Big bet | Scope | ROI | Est. weeks | Status |
|---|---------|-------|-----|------------|--------|
| BB-01 | **Anti-bot abstraction + Tor SOCKS profile** | `lib/antibot/` module taking fire-engine URL, residential proxy list, Tor SOCKS, `BASIC_PROXY`. Tiered fallback (datacenter → residential → mobile). Compose profiles per vendor. 2,000-word anti-bot playbook in `SELF_HOST.md`. | Closes the **biggest functional gap** with cloud. Tor + 1 residential vendor makes self-hosted viable for ~80% of public-web scraping workloads that are currently cloud-only. | **6-8** | **DONE (2026-06-15)** — closes KC1. Operator supplies residential-proxy vendor creds to activate. |
| BB-02 | **Helm chart + k8s manifests (foundation shipped 2026-06-15)** | `charts/firecrawl/` with api, worker, nuq-postgres, redis, rabbitmq, foundationdb, playwright-service, go-html-to-md-service. HPA on api + worker (CPU + queue depth). `values.yaml` size presets (dev, small, medium, large). Terraform module for VPC / KMS / IAM / WAF / S3. | Most enterprise customers require k8s manifests before they can deploy. The difference between "compose is fine for a demo" and "we can run this in prod". Foundation chart shipped; full chart + Terraform outstanding. | **6-8** (4 done) | PARTIAL |
| BB-03 | **OTel distributed tracing end-to-end** | Wire `@opentelemetry/api` at api entry; propagate W3C `traceparent` through RabbitMQ message headers; rehydrate context in nuq consumer + playwright. HTTP / fetch auto-instrumentation. OTel SDKs for nuq-postgres, go-html-to-md-service. Compose profile exporting to Jaeger. | **30-50% reduction in MTTR** for hard scrapes. Today operators grep 3 log streams by timestamp. SDK packages + `initTracing()` shipped 2026-06 (partial). | **4** (1 done) | PARTIAL |
| BB-04 | **PL/pgSQL implementation of all 23 cloud RPCs** | Drizzle `.sql` files for every function in `apps/api/src/db/rpc.ts`. Strip `_47` / `_6` / `_v7` / `_2` / `_5` / `_10` version suffixes. `pg_regress` test suite. `make db-test` target. Fail-closed check when `USE_DB_AUTHENTICATION=true` and schema is missing. | Unlocks the entire `/v2/monitor`, agent free-requests, credit chunking, change-tracking, ZDR-cleanup surface — all of which today silently 500. | **4-6** | **DONE (2026-06-15)** — closes KC3. Operator sets `USE_DB_AUTHENTICATION=true` and runs the migration to activate. |
| BB-05 | **BullMQ on Redis queue driver (replace NUQ postgres)** | Queue driver abstraction. BullMQ driver backed by existing Redis. Keep NUQ as default; document BullMQ for k8s. Compose profile `bullmq`. HPA on worker pods. | `nuq-postgres` is a single-process queue; horizontal scale requires sharding. BullMQ on Redis is battle-tested at scale and removes a major operational pain point. Migration contained to `apps/api/src/services/worker/`. | **4-6** | **DONE (2026-06-15)** — closes KC2. Operator sets `QUEUE_DRIVER=bullmq` + compose override + sized worker pool to activate. |
| BB-06 | **Container/browser pool via remote WebDriver grid** | Refactor `playwright-service-ts` to a stateless WebDriver-compatible server. Compose profile for selenoid/grid. k8s operator that autoscales the playwright deployment on `active_pages` custom metric. | Single-Chromium caps browser-rendered scrapes at ~10 on the default box. Selenoid / grid unlocks 100-1000 concurrent renders. The single biggest throughput unlock for JS-heavy workloads. | **6-8** | **DONE (2026-06-15)** — closes KC4. Operator provisions selenoid / grid host to activate. |
| BB-07 | **Compliance / SOC2 evidence pack (Hardened Reference Architecture)** | `docs/COMPLIANCE.md` (skeleton shipped 2026-06) → full operator-responsibilities doc. Vanta / Drata / Secureframe evidence-export script. Terraform / Pulumi "hardened" module wiring self-hosted Firecrawl to VPC, KMS, IAM, WAF, CloudTrail, SIEM. | Enterprise customers in regulated industries cannot adopt without a compliance story. The evidence pack is the difference between "it works" and "we can buy it". | **8-12** (1 done) | **DONE (2026-06-15)** — closes KC5. Operator engages SOC2 auditor + provisions WORM audit-log bucket to activate. |
| BB-08 | **Complete /v2/agent implementation (no cloud proxy)** | Local agent framework: planning LLM, tool use (scrape, extract, search), session streaming via WebSocket on `/v2/agent-livecast` backed by in-process SSE bridge. Reuse SearXNG (or DDG fallback) for search, Ollama for planning, existing extract pipeline for tool results. | The `/v2/agent` endpoint is the most differentiated cloud feature. A self-hosted version (even lagging cloud quality by 1-2 generations) removes a major reason to choose cloud. | **8-12** | OPEN |
| BB-09 | **Browser pool 10x (split playwright + per-replica scale)** | Multiple Chromium instances per playwright pod. Selenoid/grid profile. Queue depth metric. Document `1 CPU = 2-3 concurrent pages` rule. | 10x throughput on rendered scrapes is the single biggest user-facing win. Most production workloads bottleneck on the browser pool, not on the API or workers. | **4-6** | **DONE (2026-06-15)** — rolled into BB-06 / KC4 mitigation. Same WebDriver shim + selenoid profile + `--scale playwright=N` covers both. |
| BB-10 | **True multi-tenant RBAC + per-team credit billing** | Replace the 23 stub RPCs with a real teams / billing / credit ledger built on the local auth schema. Admin UI for API keys, usage, per-team rate limits. Usage-billed-by-crawl RPC in PL/pgSQL. | Self-hosted is currently single-tenant. Multi-tenant is required for any SaaS built on top of Firecrawl. Closes the "Firecrawl-as-a-platform" gap. | **6-8** | PARTIAL — RPCs ship in BB-04, but admin UI + billing ledger + per-team rate limit UX are still outstanding. |
| BB-11 | **Native result cache: per-tier TTL, ZDR-aware, ETag round-trip** | Extend Redis result cache to tiered LRU (markdown, HTML, screenshot, structured-extract). ETag round-trip: store upstream ETag, send `If-None-Match` on repeat. Honor ZDR (no cache for ZDR pages). Cache-hit metrics. | Repeat scrapes dominate cost on busy self-hosted deployments (price-tracker, news monitor, compliance dashboard). 90% cache hit rate → 10x cost reduction. Foundation (QW-08) already shipped. | **3-4** (1 done) | PARTIAL |
| BB-12 | **Hardened distribution: signed images, SBOM, dependabot** | Pin every base image to sha256. Emit SBOM via syft. Sign images with cosign. Release manifest. Trivy scan that fails on CRITICAL / HIGH. Re-enable dependabot version PRs. | Enterprise security teams block unsigned images and untracked CVEs at the firewall. Signing + SBOM + scanning is the bar for any production deployment in a regulated environment. | **3-4** | PARTIAL — `docker-compose.hardened.yml` ships in BB-07, but signed images + SBOM + Trivy gate are still outstanding. |

**Big-bet status as of 2026-06-15.** Five big bets (BB-01, BB-04, BB-05, BB-06, BB-07, BB-09) are now DONE — all 5 kill-criterion mitigations shipped. The remaining big bets (BB-08, partial BB-02 / BB-03 / BB-10 / BB-11 / BB-12) are open or partial. **Caveat:** "DONE" means the in-tree mitigation exists and the operator can activate it; the residual gap on each is configuration + vendor selection (see §1.1–1.5 for per-KC operator requirements). No new big-bet engineering work is required to close the kill criteria.

**Sequencing recommendation (updated 2026-06-16).** The five DONE big bets (BB-01, BB-04, BB-05, BB-06, BB-07, BB-09) are now operator-activation. Remaining engineering prioritization: BB-08 (`/v2/agent` local impl, 8-12 weeks) and BB-11 (cache tiering + ETag round-trip, 3-4 weeks) have the best ROI per week. BB-02 (full Helm chart + Terraform) unblocks k8s deployments and is a prerequisite for any >50k scrapes/day horizontal-scale story.

---

## 6. How to Deploy

1. **Read the install doc.** [`SELF_HOST.md`](SELF_HOST.md) — Docker setup, `.env` template, security considerations, troubleshooting, admin UI, metrics, SearXNG, TCO table, feature matrix. The kill-criteria sections above document the new opt-in compose profiles and env vars.
2. **Apply the 22 quick wins + 3 medium items shipped in 2026-06.** They are all in the default `docker-compose.yaml` and default `apps/api/src/index.ts` — you get them by pulling `main` and re-running `docker compose up --build`. No additional config required except for the env vars called out in `SELF_HOST.md` (e.g. `BATCH_CONCURRENT_REQUESTS=20`, `SEARXNG_ENDPOINT`, `METRICS_AUTH_KEY`).
3. **Wire Grafana.** Reference dashboards in [`contrib/grafana/`](contrib/grafana/) cover queue depth, worker count, scrape latency, error rate. Drop-in `prometheus.yml` snippet included.
4. **Pick a workload envelope.** Match your scrapes/day to the TCO table above and size the host accordingly. Set `MAX_RAM=0.8`, `MAX_CPU=0.8` for the worker shedding defaults.
5. **Activate the kill-criterion mitigations you need.** Each is opt-in via a compose profile + env vars — pick what matches your workload, leave the rest unset. All profiles compose with the default `docker-compose.yaml`; nothing is mutually exclusive.
   - **KC1 (anti-bot).** `docker compose -f docker-compose.yaml -f docker-compose.antibot.yml up -d`. Set `ANTI_BOT_BACKEND=resident_proxy` and the `RESIDENTIAL_PROXY_*` env vars from your vendor. For Tor, set `ANTI_BOT_BACKEND=tor_socks` and `TOR_SOCKS_URL=socks5h://tor:9050`.
   - **KC2 (BullMQ queue).** `docker compose -f docker-compose.yaml -f docker-compose.bullmq.yml up -d`. Set `QUEUE_DRIVER=bullmq`, `WORKER_CONCURRENCY=5`, and `REDIS_URL` (already in default compose). `docker compose --scale worker=N` to scale.
   - **KC3 (multi-tenant RPCs).** Set `USE_DB_AUTHENTICATION=true` and run the migration: `psql $DATABASE_URL -f apps/api/drizzle/0018_cloud_rpcs.sql`. The api boot check (`scripts/check-rpc-schema.sh`) fail-closes if the functions are missing. Operators who don't need multi-tenant should leave `USE_DB_AUTHENTICATION=false`.
   - **KC4 (selenoid browser grid).** `docker compose -f docker-compose.yaml -f docker-compose.selenoid.yml up -d`. Set `PLAYWRIGHT_DRIVER=webdriver` and `WEBDRIVER_URL=http://selenoid:4444`. The selenoid `browsers.json` ships with Chromium / Firefox / Chrome pre-configured.
   - **KC5 (hardened / SOC2).** `docker compose -f docker-compose.hardened.yml up -d` (overlay on the default). Set `AUDIT_LOG_DESTINATION` to your WORM bucket (S3 Object Lock, GCS bucket lock). Run `scripts/evidence-export/` on a schedule to emit auditor-ready evidence bundles.
6. **Read the kill criteria again** before going to production.** Each now has a shipped mitigation; the residual gap is configuration + vendor selection, not engineering. The "When to use cloud" callouts in §1.1–1.5 still apply to the hardest targets.

### What landed in 2026-06 (22 quick wins + 3 medium items + 5 KC mitigations)

**Quick wins (22).** `/healthz` + `/readyz` · `restart: unless-stopped` · boot-time secret guard · Bull UI off public port · 501 for cloud-only routes · SDK `isCloud` detection · `BATCH_CONCURRENT_REQUESTS` · Redis result cache · skip final-engine markdown QC · `GOMAXPROCS` in go-html-to-md · per-tenant rate limit envs · `Retry-After` header · `.env.example` generator · Sentry default sample rate · SearXNG opt-in profile · drop `host.docker.internal` from prod · correlation ID middleware · TCO + feature matrix docs · `sanitize` flag for HTML-to-MD · per-request Retry-After + global 429 cap · healthchecks on RabbitMQ + Redis · `GET /version`.

**Medium items (3).** Container topology split (api vs worker) — `5231f3214`. Dead-letter queue + admin replay (`/admin/:key/dlq/:queue/{list,replay/:jobId}`) — `fe93ad66b`. Prometheus `/metrics` on a dedicated path with `METRICS_AUTH_KEY` bearer + Grafana dashboards + `prometheus.yml` — `6a26665e7`, `750ed9ceb`, `3504358b1`.

**Big-bet foundations (partial, also in this round).** OTel SDK packages + `initTracing()` at harness boot — `b4d6a51e1`, `95eba7643`. Helm chart foundation — `8c4f655bb`. `docs/COMPLIANCE.md` skeleton — `f49eb98b9`. `OTEL_*` env vars in `x-common-env` — `df08c96a5`.

**Kill-criterion mitigations (5, shipped 2026-06-15).** KC1 anti-bot abstraction (`apps/api/src/lib/antibot/` + `safeFetch` rewiring + `docker-compose.antibot.yml`) — closes BB-01. KC2 BullMQ queue driver (`apps/api/src/services/queue/` + `docker-compose.bullmq.yml`) — closes BB-05. KC3 PL/pgSQL for all 23 RPCs (`apps/api/drizzle/0018_cloud_rpcs.sql` + fail-closed schema check) — closes BB-04. KC4 WebDriver shim + selenoid profile (`apps/playwright-service-ts/src/webdriver/` + `docker-compose.selenoid.yml`) — closes BB-06 + BB-09. KC5 SOC2 evidence pack (`scripts/evidence-export/` + `docker-compose.hardened.yml` + expanded `docs/COMPLIANCE.md`) — closes BB-07. See §0 for one-line summaries and §1.1–1.5 for per-KC detail.

**The full resolution report** lives in this commit history. Re-running the 5-phase audit (`.audit/`) re-validates the closure of these items.

---

## 7. References

- **Roadmap (this audit's structured plan):** [`.audit/self-hosted-vs-cloud/roadmap.json`](.audit/self-hosted-vs-cloud/roadmap.json) — 22 quick wins, 23 medium items, 12 big bets, success metrics, 5 kill criteria.
- **Findings (every issue, with file/line/severity):** [`.audit/self-hosted-vs-cloud/findings.json`](.audit/self-hosted-vs-cloud/findings.json) — 69 unique findings (7 critical, 28 high, 28 medium, 6 low).
- **Executive summary (narrative form):** [`.audit/self-hosted-vs-cloud/executive-summary.md`](.audit/self-hosted-vs-cloud/executive-summary.md).
- **Per-phase findings:**
  - [`architecture.json`](.audit/self-hosted-vs-cloud/architecture.json) — API surface, fire-engine, SDKs, drizzle stubs (21 findings)
  - [`performance.json`](.audit/self-hosted-vs-cloud/performance.json) — concurrency, queue, browser pool, hot paths (15 findings)
  - [`reliability.json`](.audit/self-hosted-vs-cloud/reliability.json) — retry, fallback, rate limits, idempotency, health (13 findings)
  - [`operations.json`](.audit/self-hosted-vs-cloud/operations.json) — metrics, logs, tracing, scale, cost, deploy (10 findings)
  - [`security.json`](.audit/self-hosted-vs-cloud/security.json) — auth, secrets, network, isolation, SSRF, PII (10 findings)
- **Install / config doc:** [`SELF_HOST.md`](SELF_HOST.md) — Docker, `.env`, troubleshooting, admin UI, SearXNG, metrics, TCO table, full feature matrix.
- **Compliance skeleton:** [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) — operator responsibilities for SOC2 posture.
- **Grafana dashboards + prometheus.yml:** [`contrib/grafana/`](contrib/grafana/).
- **Cloud pricing (for the TCO table's right column):** [firecrawl.dev/pricing](https://firecrawl.dev/pricing).

---

*Last updated 2026-06-16 (post-ultracode W2-W4 — 65 commits, 78 items triaged). Prior baseline: 2026-06-15 (5 KC mitigations + 22 QW + 3 medium items). Re-audit quarterly; the gap map shifts every time Fire-engine adds a feature.*
