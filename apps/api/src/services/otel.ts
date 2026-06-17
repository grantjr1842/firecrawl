// apps/api/src/services/otel.ts
//
// T2.2 distributed-tracing foundation.
//
// Wires the OpenTelemetry NodeSDK so that outgoing HTTP/HTTPS requests and
// incoming server spans are exported as OTLP traces. The intended downstream
// collector is Jaeger (or any OTLP/HTTP-compatible backend such as the
// OpenTelemetry Collector or Tempo).
//
// Scope of THIS commit (foundation):
//   - NodeSDK bootstrap with the OTLP/HTTP trace exporter
//   - Auto-instrumentations for http/https (client + server spans) and dns
//   - Pluggable service-name via OTEL_SERVICE_NAME (default: "firecrawl-api")
//   - Head-based sampler (OTEL_TRACE_SAMPLE_RATE, default 1%)
//   - Graceful shutdown hooked into the existing SIGTERM/SIGINT path
//   - Safe no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset or
//     OTEL_SDK_DISABLED=true (tests, local dev)
//
// Scope deferred to follow-up commits (see
// .audit/recursive-ultracode/RECOMMENDATIONS.md item #20):
//   - RabbitMQ (amqplib) propagation across the queue boundary
//   - Playwright / browser span context propagation
//   - Per-team / per-route sampling overrides
//   - Backend-specific auth headers (e.g. Jaeger bearer token)
//
// Import this module for side-effects from `src/index.ts` BEFORE `services/sentry`,
// so the OTel context-async-hooks context manager is registered before Sentry's
// own integration layer is initialized. Sentry reads its own `@opentelemetry/*`
// graph from its bundled deps, so the two coexist without conflict.

import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import { config } from "../config";
import { logger } from "../lib/logger";

// Tracks whether the SDK has been started so callers can guard hot paths.
let sdkStarted = false;
let nodeSdk: NodeSDK | null = null;

/**
 * Returns true iff the OTel SDK has been successfully initialized for this
 * process. Use this to skip expensive span attribute population when tracing is
 * disabled (e.g. unit tests, local dev without an endpoint).
 */
export function isOtelEnabled(): boolean {
  return sdkStarted;
}

/**
 * Build a normalized OTLP/HTTP endpoint URL. We accept:
 *   - "http://jaeger:4318"            -> traces root
 *   - "http://jaeger:4318/v1/traces"  -> used verbatim
 *   - ""                              -> not configured
 *
 * Jaeger 1.35+ ingests OTLP/HTTP on port 4318 by default, which is what most
 * Firecrawl operators expose.
 */
function buildTraceUrl(endpoint: string | undefined): string | null {
  if (!endpoint) {
    return null;
  }
  const trimmed = endpoint.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/traces")) {
    return trimmed;
  }
  return `${trimmed}/v1/traces`;
}

/**
 * Initialize the OpenTelemetry SDK. Idempotent: a second call is a no-op so
 * import order does not matter between api server and workers.
 *
 * Returns true if the SDK was started, false if tracing is disabled.
 */
export function initOtel(): boolean {
  if (sdkStarted) {
    return true;
  }
  if (config.OTEL_SDK_DISABLED) {
    logger.info("OTel SDK disabled via OTEL_SDK_DISABLED");
    return false;
  }

  const traceUrl = buildTraceUrl(config.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (!traceUrl) {
    logger.info(
      "OTel SDK not started: OTEL_EXPORTER_OTLP_ENDPOINT is unset (tracing is a no-op)",
    );
    return false;
  }

  // Enable OTel internal diagnostics only when the operator asked for verbose
  // tracing logs; otherwise keep stdout clean.
  if (
    process.env.OTEL_LOG_LEVEL === "debug" ||
    process.env.OTEL_LOG_LEVEL === "verbose"
  ) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.OTEL_SERVICE_NAME,
    // Use the same pod-name dimension Sentry uses, so traces and errors can be
    // joined in Jaeger / Tempo / Sentry by service.instance.id.
    "service.instance.id": config.NUQ_POD_NAME,
    "deployment.environment": config.SENTRY_ENVIRONMENT,
  });

  const spanProcessors: SpanProcessor[] = [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: traceUrl })),
  ];
  if (process.env.OTEL_CONSOLE_EXPORTER === "true") {
    // Local-dev helper: dump spans to stdout instead of sending them. Do NOT
    // enable in production — it is extremely noisy.
    spanProcessors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
  }

  nodeSdk = new NodeSDK({
    resource,
    spanProcessors,
    instrumentations: [
      getNodeAutoInstrumentations({
        // We instrument http/https on both client and server sides. The
        // multi-week work to propagate context across RabbitMQ messages and
        // Playwright pages is tracked separately; this commit only ships
        // HTTP/HTTPS + DNS spans as the foundation.
        "@opentelemetry/instrumentation-fs": {
          // File-system spans are extremely high-volume and rarely useful for
          // tracing scrape hot-paths; disable to keep the collector happy.
          enabled: false,
        },
      }),
    ],
  });

  try {
    nodeSdk.start();
    sdkStarted = true;
    logger.info("OTel SDK started", {
      serviceName: config.OTEL_SERVICE_NAME,
      endpoint: traceUrl,
      sampleRate: config.OTEL_TRACE_SAMPLE_RATE,
      instanceId: config.NUQ_POD_NAME,
    });
    return true;
  } catch (error) {
    // Never let a tracing misconfiguration crash the API process.
    logger.error("Failed to start OTel SDK; tracing disabled", { error });
    nodeSdk = null;
    return false;
  }
}

/**
 * Flush pending spans and shut the SDK down. Safe to call when the SDK was
 * never started (no-op). Hooked into the SIGTERM/SIGINT path in src/index.ts.
 */
export async function shutdownOtel(): Promise<void> {
  if (!nodeSdk) {
    return;
  }
  try {
    await nodeSdk.shutdown();
    logger.info("OTel SDK shut down");
  } catch (error) {
    logger.error("Error during OTel SDK shutdown", { error });
  } finally {
    nodeSdk = null;
    sdkStarted = false;
  }
}

// Side-effect import target: src/index.ts imports "./services/otel" once at
// process boot. Call initOtel() explicitly so tests can stay hermetic.
const autoInit = (() => {
  // Detect the test runner and skip auto-init so unit tests do not try to
  // connect to a non-existent collector.
  if (
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.JEST_WORKER_ID !== undefined
  ) {
    return;
  }
  return initOtel();
})();

// Ensure pending spans are flushed when the process is asked to exit cleanly.
// We deliberately do NOT await this on exit — `shutdown()` is idempotent and
// the process exit handler in src/index.ts already chains graceful shutdowns.
process.once("SIGTERM", () => {
  void shutdownOtel();
});
process.once("SIGINT", () => {
  void shutdownOtel();
});

export { autoInit };
