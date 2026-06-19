import "dotenv/config";
import { z } from "zod";

/* Codecs */
const delimitedList = (separator = ",") => {
  return z.codec(z.string(), z.array(z.string()), {
    decode: str => (str ? str.split(separator).map(s => s.trim()) : []),
    encode: arr => arr.join(separator),
  });
};

const emptyStringAsUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(value => (value === "" ? undefined : value), schema.optional());

const emptyStringAsDefault = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(value => (value === "" ? undefined : value), schema);

// Ethereum address schema: validates 0x followed by 40 hex characters
const ethereumAddress = z
  .string()
  .transform(s => s.trim())
  .pipe(
    z.union([
      z.literal(""), // Allow empty string (treated as undefined below)
      z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address format"),
    ]),
  )
  .transform(s => (s === "" ? undefined : (s as `0x${string}`)))
  .optional();

/* Schema */
const configSchema = z.object({
  // Application
  ENV: z.string().optional(),
  HOST: z.string().default("localhost"),
  PORT: z.coerce.number().default(3002),
  IS_PRODUCTION: z.stringbool().optional(),
  IS_KUBERNETES: z.stringbool().optional(),
  FIRECRAWL_APP_HOST: z.string().default("firecrawl-app-service"),
  FIRECRAWL_APP_PORT: z.string().default("3002"),
  FIRECRAWL_APP_SCHEME: z.string().default("http"),
  LOGGING_LEVEL: z.string().optional(),
  FIRECRAWL_DASHBOARD_URL: z.url().default("https://www.firecrawl.dev"),
  SUPPORT_AGENT_URL: z.string().url().optional(),
  SUPPORT_AGENT_VERCEL_BYPASS_SECRET: z.string().optional(),
  RESEARCH_PROXY_URL: z.string().url().optional(),

  // Express
  EXPRESS_TRUST_PROXY: z.coerce.number().optional(),

  // Keyless free tier (scrape/search/interact without an API key, per-IP/day).
  // Non-negative integers; 0 means "enabled but no budget", unset means "off".
  KEYLESS_CREDITS_PER_DAY: z.coerce.number().int().nonnegative().optional(),
  KEYLESS_REQUESTS_PER_DAY: z.coerce.number().int().nonnegative().optional(),
  // Shared secret that lets a trusted proxy (e.g. the hosted MCP server)
  // forward the real client IP for keyless rate-limiting via the
  // `x-firecrawl-keyless-ip` header. Untrusted callers can't override their IP.
  KEYLESS_PROXY_SECRET: z.string().optional(),
  // Optional Spur Context API token (https://docs.spur.us/context-api). When
  // set, keyless requests have their client IP checked against Spur and are
  // refused if the IP fronts anonymizing/rotating infrastructure (VPN/proxy/
  // TOR). Unset disables the check entirely (keyless behaves as before).
  SPUR_API_KEY: z.string().optional(),

  // API Keys & Authentication
  BULL_AUTH_KEY: z.string().optional(),
  // Optional shared secret for the unauthenticated /metrics prom endpoint
  // (admin-ops-07). Unset disables the endpoint entirely; set enables it
  // and gates it on a Bearer / X-Metrics-Key header. Separate from
  // BULL_AUTH_KEY so Prometheus scrapers do not share the same secret as
  // the bull-board UI and the destructive acuc-cache-clear endpoint.
  METRICS_AUTH_KEY: z.string().min(16).optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  LLAMAPARSE_API_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  AUTUMN_SECRET_KEY: z.string().optional(),
  AUTUMN_REQUEST_TRACK_EXPERIMENT: z.string().optional(),
  AUTUMN_REQUEST_TRACK_EXPERIMENT_PERCENT: z.coerce.number().default(100),
  RESEND_API_KEY: z.string().optional(),
  PREVIEW_TOKEN: z.string().optional(),
  SEARCH_PREVIEW_TOKEN: z.string().optional(),
  SEARCH_SERVICE_API_SECRET: z.string().optional(),
  SEARCH_FEEDBACK_MAX_AGE_SEC: z.coerce.number().int().positive().default(120),
  SEARCH_FEEDBACK_DAILY_CAP_CREDITS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(100),
  FEEDBACK_MAX_AGE_SEC: z.coerce.number().int().positive().default(120),
  FEEDBACK_DAILY_CAP_CREDITS: z.coerce.number().int().nonnegative().default(50),
  FEEDBACK_REFUND_ENABLED: z.stringbool().default(true),

  // OAuth token introspection
  OAUTH_INTROSPECT_URL: z.string().optional(),
  OAUTH_INTROSPECT_SECRET: z.string().optional(),

  // Agent auth discovery (RFC 9728 WWW-Authenticate on 401)
  AGENT_AUTH_RESOURCE_METADATA_URL: z
    .url()
    .default("https://www.firecrawl.dev/.well-known/oauth-protected-resource"),

  // Database & Storage
  POSTGRES_HOST: z.string().default("localhost"),
  POSTGRES_PORT: z.string().default("5432"),
  POSTGRES_DB: z.string().default("postgres"),
  POSTGRES_USER: z.string().default("postgres"),
  POSTGRES_PASSWORD: z.string().default("postgres"),
  DATABASE_URL: z.string().optional(),
  DATABASE_REPLICA_URL: z.string().optional(),
  INDEX_DATABASE_URL: z.string().optional(),
  INDEX_CACHE_REDIS_URL: z.string().optional(),
  // Negative (miss) caching TTL for index URL->id lookups, in ms. 0 disables
  // it; the cache then only shields lookups that find data. A positive value
  // (e.g. 600000 = 10min) also short-circuits repeat lookups for URLs with no
  // index entry. Kept short so any missed cache-clear self-heals quickly.
  INDEX_CACHE_NEGATIVE_TTL_MS: z.coerce.number().default(0),
  REDIS_URL: z.string().optional(),
  REDIS_EVICT_URL: z.string().optional(),
  REDIS_RATE_LIMIT_URL: z.string().optional(),
  NUQ_DATABASE_URL: z.string().optional(),
  NUQ_DATABASE_URL_LISTEN: z.string().optional(),
  NUQ_RABBITMQ_URL: z.string().optional(),
  FDB_CLUSTER_FILE: emptyStringAsUndefined(z.string()),
  NUQ_BACKEND: emptyStringAsUndefined(z.enum(["pg", "fdb"])),
  NUQ_FDB_READY_SHARDS: emptyStringAsDefault(
    z.coerce.number().int().positive().default(2048),
  ),
  // 1 = strict (priority, FIFO) promotion order per team; raise for teams with
  // extreme finish rates at the cost of approximate cross-shard ordering
  NUQ_FDB_TEAM_PENDING_SHARDS: emptyStringAsDefault(
    z.coerce.number().int().positive().default(1),
  ),
  NUQ_FDB_TIME_BUCKETS: emptyStringAsDefault(
    z.coerce.number().int().positive().default(16),
  ),

  // Google Cloud Storage
  GCS_BUCKET_NAME: z.string().optional(),
  GCS_CREDENTIALS: z.string().optional(),
  GCS_FIRE_ENGINE_BUCKET_NAME: z.string().optional(),
  GCS_INDEX_BUCKET_NAME: z.string().optional(),
  GCS_MEDIA_BUCKET_NAME: z.string().optional(),

  // ClickHouse (Search Analytics)
  CLICKHOUSE_ANALYTICS_URL: z.string().optional(),
  CLICKHOUSE_ANALYTICS_DATABASE: z.string().optional(),

  // Search highlights (beta): query-highlights model service. URL is the base
  // (e.g. https://firecrawl--query-highlights.modal.run); TOKEN is the bearer
  // token sent on every request.
  HIGHLIGHT_MODEL_URL: z.string().optional(),
  HIGHLIGHT_MODEL_TOKEN: z.string().optional(),

  // Fire Engine
  FIRE_ENGINE_BETA_URL: z.string().optional(),
  FIRE_ENGINE_STAGING_URL: z.string().optional(),
  FIRE_ENGINE_AB_URL: z.string().optional(),
  FIRE_ENGINE_AB_RATE: z.coerce.number().optional(),
  FIRE_ENGINE_AB_MODE: z.enum(["mirror", "split"]).default("mirror"),

  // Indexer
  INDEXER_RABBITMQ_URL: z.string().optional(),
  INDEXER_TRAFFIC_SHARE: z.coerce.number().default(0.0),

  // ScrapeURL
  SCRAPEURL_AB_HOST: z.string().optional(),
  SCRAPEURL_AB_RATE: z.coerce.number().optional(),
  SCRAPEURL_AB_EXTEND_MAXAGE: z.stringbool().optional(),
  SCRAPEURL_ENGINE_WATERFALL_DELAY_MS: z.coerce.number().default(0),

  // Scrape Retry Limits
  SCRAPE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
  SCRAPE_MAX_FEATURE_TOGGLES: z.coerce.number().int().positive().default(3),
  SCRAPE_MAX_FEATURE_REMOVALS: z.coerce.number().int().positive().default(3),
  SCRAPE_MAX_PDF_PREFETCHES: z.coerce.number().int().positive().default(2),
  SCRAPE_MAX_DOCUMENT_PREFETCHES: z.coerce.number().int().positive().default(2),

  // Search Services
  SEARXNG_ENDPOINT: z.string().optional(),
  SEARXNG_ENGINES: z.string().optional(),
  SEARXNG_CATEGORIES: z.string().optional(),
  SEARCH_SERVICE_URL: z.string().optional(),
  SEARCH_INDEX_SAMPLE_RATE: z.coerce.number().default(0.1),
  ENABLE_SEARCH_INDEX: z.stringbool().optional(),

  // Worker Configuration
  WORKER_PORT: z.coerce.number().default(3005),
  NUQ_WORKER_PORT: z.coerce.number().default(3000).catch(3000), // todo: investigate why .catch is needed
  NUQ_WORKER_START_PORT: z.coerce.number().default(3006),
  NUQ_WORKER_COUNT: z.coerce.number().default(5),
  NUQ_PREFETCH_WORKER_PORT: z.coerce.number().default(3011).catch(3011), // todo: investigate why .catch is needed
  NUQ_RECONCILER_WORKER_PORT: z.coerce.number().default(3012).catch(3012),
  EXTRACT_WORKER_PORT: z.coerce.number().default(3004),
  NUQ_WAIT_MODE: z.string().optional(),

  // Harness Configuration
  HARNESS_STARTUP_TIMEOUT_MS: z.coerce.number().default(60000),

  // Job & Lock Management
  JOB_LOCK_EXTEND_INTERVAL: z.coerce.number().default(10000),
  JOB_LOCK_EXTENSION_TIME: z.coerce.number().default(60000),
  WORKER_LOCK_DURATION: z.coerce.number().default(60000),
  WORKER_STALLED_CHECK_INTERVAL: z.coerce.number().default(30000),
  CONNECTION_MONITOR_INTERVAL: z.coerce.number().default(10),
  CANT_ACCEPT_CONNECTION_INTERVAL: z.coerce.number().default(2000),

  // Proxy
  PROXY_SERVER: z.string().optional(),
  PROXY_USERNAME: z.string().optional(),
  PROXY_PASSWORD: z.string().optional(),

  // Anti-bot tiered router (W3-SEC-001)
  FIRECRAWL_ANTIBOT_ENABLED: z
    .preprocess(v => {
      if (v === undefined || v === null || v === "") return undefined;
      return v;
    }, z.stringbool())
    .optional(),
  FIRECRAWL_TOR_SOCKS_URL: z.string().optional(),
  FIRECRAWL_PROXY_VENDOR_URL: z.string().optional(),
  FIRECRAWL_PROXY_VENDOR_ROTATE: z
    .preprocess(
      v => (v === undefined || v === null || v === "" ? false : v),
      z.stringbool(),
    )
    .default(false),
  // ANTI-BOT-6: sticky residential-proxy session configuration.
  // When FIRECRAWL_PROXY_VENDOR_ROTATE is false, the residential
  // provider derives a stable `sessionId` from a scope key (default:
  // crawl id, then domain) so that exit IP reputation can build up
  // across requests. Sites that fingerprint on exit IP (Amazon,
  // Yelp, LinkedIn) otherwise see a fresh IP faster than the
  // rate-limit window and trigger CAPTCHAs.
  FIRECRAWL_PROXY_STICKY_TTL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(600_000),
  FIRECRAWL_PROXY_STICKY_SCOPE: z
    .enum(["session", "crawl", "domain"])
    .default("crawl"),
  // Anti-bot vendor integration (T1.1; post-ultracode item #16).
  // When FIRECRAWL_ANTIBOT_VENDOR is "brightdata" or "smartproxy", the
  // router will instantiate the corresponding VendorAdapter and use
  // it to build per-request proxy URLs for the residential tier.
  FIRECRAWL_ANTIBOT_VENDOR: z
    .enum(["brightdata", "smartproxy", "generic"])
    .optional(),
  FIRECRAWL_ANTIBOT_VENDOR_GEO: z.string().optional(),
  // Bright Data credentials
  FIRECRAWL_BRIGHTDATA_USERNAME: z.string().optional(),
  FIRECRAWL_BRIGHTDATA_PASSWORD: z.string().optional(),
  FIRECRAWL_BRIGHTDATA_HOST: z.string().optional(),
  FIRECRAWL_BRIGHTDATA_PORT: z.coerce.number().optional(),
  // Smartproxy credentials
  FIRECRAWL_SMARTPROXY_USERNAME: z.string().optional(),
  FIRECRAWL_SMARTPROXY_PASSWORD: z.string().optional(),
  FIRECRAWL_SMARTPROXY_HOST: z.string().optional(),
  FIRECRAWL_SMARTPROXY_PORT: z.coerce.number().optional(),
  FIRECRAWL_ANTIBOT_TIERS: z.string().optional(),
  FIRECRAWL_ANTIBOT_RETRY_ON_STATUS: z.string().default("403,429,503"),
  FIRECRAWL_ANTIBOT_BYPASS_PREFIXES: z.string().optional(),
  // TLS fingerprint rotation (W3-SEC-001)
  FIRECRAWL_TLS_FINGERPRINT_ENABLED: z
    .preprocess(
      v => (v === undefined || v === null || v === "" ? false : v),
      z.stringbool(),
    )
    .default(false),
  FIRECRAWL_TLS_FINGERPRINT: z
    .enum([
      "chrome_120",
      "chrome_119",
      "firefox_120",
      "safari_16_0",
      "edge_101",
      "opera_85",
      "okhttp_4_10",
    ])
    .default("chrome_120"),
  // Akamai H2 dispatcher (W3-SEC-001)
  FIRECRAWL_AKAMAI_H2_ENABLED: z
    .preprocess(
      v => (v === undefined || v === null || v === "" ? false : v),
      z.stringbool(),
    )
    .default(false),

  // External Services
  PLAYWRIGHT_MICROSERVICE_URL: z.string().optional(),
  HTML_TO_MARKDOWN_SERVICE_URL: z.string().optional(),
  SMART_SCRAPE_API_URL: z.string().optional(),

  // PDF Processing
  PDF_MU_V2_BASE_URL: z.string().optional(),
  PDF_MU_V2_API_KEY: z.string().optional(),
  PDF_MU_V2_EXPERIMENT: z.string().optional(),
  PDF_MU_V2_EXPERIMENT_PERCENT: z.coerce.number().default(100),

  // Default PDF renderer used by the scrape→PDF pipeline. `weasyprint`
  // is the offline, system-binary path; `pandoc-pdf` is reserved for a
  // future latex-style output; `none` disables local rendering entirely
  // (callers must use a downstream service).
  PDF_DEFAULT_RENDERER: z
    .enum(["weasyprint", "pandoc-pdf", "none"])
    .default("weasyprint"),
  // Hard upper bound on a single weasyprint invocation. The renderer
  // installs a SIGKILL timer at this boundary so a stuck render can't
  // hold a worker hostage.
  PDF_RENDER_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60000),

  // MinerU direct routing (bypass Rust extraction for a % of traffic)
  MINERU_PERCENT: z.coerce.number().min(0).max(100).default(0),

  // Fire PDF (replaces MinerU for a % of traffic)
  FIRE_PDF_ENABLE: z.stringbool().optional(),
  FIRE_PDF_PERCENT: z.coerce.number().min(0).max(100).default(10),
  FIRE_PDF_BASE_URL: z.string().optional(),
  FIRE_PDF_API_KEY: z.string().optional(),

  // RunPod
  RUNPOD_MU_API_KEY: z.string().optional(),
  RUNPOD_MU_POD_ID: z.string().optional(),

  // PDF Rust Extraction (pdf-inspector)
  PDF_RUST_EXTRACT_ENABLE: z.stringbool().optional(),
  PDF_SHADOW_COMPARISON_ENABLE: z.stringbool().optional(),

  // Webhooks
  SELF_HOSTED_WEBHOOK_URL: z.string().optional(),
  SELF_HOSTED_WEBHOOK_HMAC_SECRET: z.string().optional(),
  SLACK_WEBHOOK_URL: z.string().optional(),
  SLACK_ADMIN_WEBHOOK_URL: z.string().optional(),
  DISABLE_WEBHOOK_DELIVERY: z.stringbool().optional(),
  ALLOW_LOCAL_WEBHOOKS: z.stringbool().optional(),
  WEBHOOK_USE_RABBITMQ: z.stringbool().optional(),

  // Admin operator allowlist. Comma-separated emails (matched against
  // the JWT email after authMiddleware runs) whose callers can reach
  // cross-team admin endpoints without the X-Admin-Role header.
  ADMIN_EMAILS: z.string().optional(),

  // Firecrawl Features
  FIRECRAWL_DEBUG_FILTER_LINKS: z.stringbool().optional(),
  FIRECRAWL_LOG_TO_FILE: z.stringbool().optional(),
  // Dev-only structured lifecycle tracing. Default ON outside of
  // production so scrape/crawl events surface in the local JSON log
  // stream; set FIRECRAWL_DEV_TRACE=false in CI or noisy envs to
  // silence it. FIRECRAWL_DEV_TRACE_BODY, when set, includes the
  // first 4KB of any 'body' field passed to devTrace (handy for
  // debugging transform failures, off by default to keep logs small).
  FIRECRAWL_DEV_TRACE: z.stringbool().optional(),
  FIRECRAWL_DEV_TRACE_BODY: z.stringbool().optional(),
  // Console log format for stdout. Default 'json' so docker/k8s logs and
  // downstream log shippers (Loki promtail, fluentbit, Vector, etc.) can
  // parse every line. Set to 'text' for a human-readable printf format
  // during local development. The file transport (FIRECRAWL_LOG_TO_FILE)
  // is always JSON regardless of this setting.
  FIRECRAWL_LOG_FORMAT: z.enum(["json", "text"]).default("json"),
  FIRECRAWL_SAVE_MOCKS: z.stringbool().optional(),
  FIRECRAWL_INDEX_WRITE_ONLY: z.stringbool().optional(),
  DISABLE_BLOCKLIST: z.stringbool().optional(),
  FORCED_ENGINE_DOMAINS: z.string().optional(),
  DEBUG_BRANDING: z.stringbool().optional(),

  // AI/ML
  MODEL_NAME: z.string().optional(),
  MODEL_EMBEDDING_NAME: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),
  VERTEX_CREDENTIALS: z.string().optional(),

  // LangSmith (tracing for interact agent)
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_PROJECT: z.string().optional(),
  LANGSMITH_ENDPOINT: z.string().optional(),
  LANGSMITH_TRACING: z.stringbool().optional(),

  // Rate Limiting
  RATE_LIMIT_TEST_API_KEY_SCRAPE: z.coerce.number().optional(),
  RATE_LIMIT_TEST_API_KEY_CRAWL: z.coerce.number().optional(),

  // QR-001(b): API-edge load-shedding concurrency caps. A request that
  // would push a team's in-flight count over the cap is rejected with
  // 429 + Retry-After (in seconds). 0 disables the limiter for that
  // endpoint. The caps sit at the API edge (controllers/v2/scrape.ts,
  // controllers/v2/crawl.ts) and act as a fast-fail before the team
  // semaphore does its blocking acquire, so a thundering herd from one
  // team can't tie up controller slots waiting on NuQ.
  SCRAPE_API_CONCURRENCY_PER_TEAM: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(50),
  CRAWL_API_CONCURRENCY_PER_TEAM: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(5),

  // Testing
  TEST_API_KEY: z.string().optional(),
  TEST_API_URL: z.string().default("http://127.0.0.1:3002"),
  TEST_TEAM_ID: z.string().optional(),
  TEST_SUITE_SELF_HOSTED: z.stringbool().optional(),
  TEST_SUITE_WEBSITE: z.string().default("http://127.0.0.1:4321"),
  USE_DB_AUTHENTICATION: z.stringbool().optional(),

  // Indexing
  BACKGROUND_INDEX_TEAM_ID: z.string().optional(),
  PRECRAWL_TEAM_ID: z.string().optional(),

  // Payment (x402)
  X402_ENDPOINT_PRICE_USD: z.string().optional(),
  X402_NETWORK: z.string().optional(),
  X402_PAY_TO_ADDRESS: ethereumAddress,
  X402_FACILITATOR_URL: z.string().url().optional(),

  // System
  MAX_CPU: z.coerce.number().default(0.8),
  MAX_RAM: z.coerce.number().default(0.8),
  SYS_INFO_MAX_CACHE_DURATION: z.coerce.number().default(150),
  USE_GO_MARKDOWN_PARSER: z.stringbool().optional(),

  // ---------------------------------------------------------------------
  // Native result cache (BB-11). The cache stores the post-transformer
  // Document for each (url, tier) tuple so repeat scrapes can skip the
  // engine waterfall. Operators can tune the per-tier TTLs to match
  // their freshness needs and the bound on LRU size (RESULT_CACHE_MAX_KEYS
  // is enforced via Redis maxmemory-policy=allkeys-lru, see
  // services/result-cache.ts). ETag round-trip is opt-out via
  // RESULT_CACHE_USE_ETAG=false. ZDR requests always bypass both reads
  // and writes - see services/result-cache.ts for the privacy rationale.
  // ---------------------------------------------------------------------
  RESULT_CACHE_TIER_MARKDOWN_TTL: z.coerce.number().default(3600),
  RESULT_CACHE_TIER_HTML_TTL: z.coerce.number().default(1800),
  RESULT_CACHE_TIER_SCREENSHOT_TTL: z.coerce.number().default(600),
  RESULT_CACHE_TIER_EXTRACT_TTL: z.coerce.number().default(300),
  RESULT_CACHE_USE_ETAG: z
    .preprocess(
      v => (v === undefined || v === null || v === "" ? true : v),
      z.stringbool(),
    )
    .default(true),
  // Soft cap on the number of cache entries; documented in the module
  // comment as a hint for the Redis maxmemory / maxmemory-sample tuning.
  RESULT_CACHE_MAX_KEYS: z.coerce.number().default(100000),

  // Sentry
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACE_SAMPLE_RATE: z.coerce.number().default(0.01),
  SENTRY_ERROR_SAMPLE_RATE: z.coerce.number().default(0.05),
  SENTRY_ENVIRONMENT: z.string().default("production"),
  NUQ_POD_NAME: z.string().default("main"),

  // OpenTelemetry / distributed tracing (T2.2 foundation)
  // OTLP endpoint in the form "http://jaeger:4318" or "http://otel-collector:4318".
  // When unset, the OTel SDK stays uninitialized and tracing is a no-op.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().default("firecrawl-api"),
  // Head-based sampler; default 1% to mirror SENTRY_TRACE_SAMPLE_RATE.
  OTEL_TRACE_SAMPLE_RATE: z.coerce.number().default(0.01),
  // Hard kill-switch for the SDK without removing env wiring (e.g. for tests).
  OTEL_SDK_DISABLED: z.stringbool().default(false),

  // Billing
  AUTO_RECHARGE_ENABLED: z.stringbool().default(false),

  // Miscellaneous
  IDMUX_URL: z.string().optional(),
  GITHUB_RUN_NUMBER: z.string().optional(),
  GITHUB_REF_NAME: z.string().optional(),
  RESTRICTED_COUNTRIES: delimitedList(",").optional(),
  DISABLE_ENGPICKER: z.stringbool().optional(),
  DISABLE_MONITORING: z.stringbool().default(false),

  EXTRACT_V3_BETA_URL: z.string().optional(),
  AGENT_INTEROP_SECRET: z.string().optional(),

  // Wikipedia Enterprise API
  WIKIPEDIA_ENTERPRISE_USERNAME: z.string().optional(),
  WIKIPEDIA_ENTERPRISE_PASSWORD: z.string().optional(),

  // Browser Service
  BROWSER_SERVICE_URL: z.string().optional(),
  BROWSER_SERVICE_API_KEY: z.string().optional(),
  BROWSER_SERVICE_WEBHOOK_SECRET: z.string().optional(),

  // Audio (avgrab)
  AVGRAB_SERVICE_URL: z.string().optional(),

  // PII Redaction (fire-privacy)
  FIRE_PRIVACY_URL: z.string().optional(),
  FIRE_PRIVACY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  NUQ_PREFETCH_WORKER_HEARTBEAT_URL: z.string().optional(),

  ZDRCLEANER_HEARTBEAT_URL: z.string().optional(),

  // Deterministic JSON extraction (reusable-json-mode)
  EXTRACT_CODEGEN_MODEL: z.string().default("gemini-3.1-flash-lite"),
  EXTRACT_ANCHOR_MODEL: z.string().default("openai/gpt-oss-120b"),
  EXTRACT_LIGHT_MODEL: z.string().default("openai/gpt-oss-20b"),
  CODE_SANDBOX_URL: z.string().default("ws://code-sandbox:3001"),

  // ---------------------------------------------------------------------------
  // BB-10: Per-tenant cache isolation. When true, getCachedResultTiered
  // and setCachedResultTiered prefix the Redis key with a team hash so
  // teams don't share cached bytes. Default off to preserve the
  // high-hit-rate shared global cache for self-hosted installs.
  // ---------------------------------------------------------------------------
  RESULT_CACHE_TEAM_ISOLATION: z.coerce.boolean().default(false),

  // ---------------------------------------------------------------------------
  // PERF-2026-06-17-6: Batch cache precheck. When true (default), the v1
  // batch-scrape controller does an O(n) Redis lookup against the tiered
  // result cache BEFORE enqueuing any URL into NuQ. URLs that hit the
  // cache are merged into the batch result store directly and never
  // enqueued, saving the queue-add + lock-acquire + team-semaphore cost
  // for cache-warm URLs. ZDR requests bypass the precheck entirely, and
  // the v1 batch controller already sets `disableSmartWaitCache: true`,
  // which the precheck path flips back off for the cache-hit URLs only.
  // ---------------------------------------------------------------------------
  RESULT_CACHE_PRECHECK_BATCH: z.coerce.boolean().default(true),
});

export const config = configSchema.parse(process.env);
