import { vi } from "vitest";

// vi.mock is hoisted to the top of the file; the factory references must use
// vi.hoisted() to avoid temporal-dead-zone errors under Vitest.

const spies = vi.hoisted(() => ({
  nodeSdkCtor: vi.fn(),
  nodeSdkStart: vi.fn(),
  nodeSdkShutdown: vi.fn(),
  otlpExporterCtor: vi.fn(),
  batchSpanProcessorCtor: vi.fn(),
}));

vi.mock("@opentelemetry/sdk-node", () => {
  function FakeNodeSDK(
    this: { config: unknown; start: () => void; shutdown: () => void },
    config: unknown,
  ) {
    spies.nodeSdkCtor(config);
    this.config = config;
    this.start = spies.nodeSdkStart;
    this.shutdown = spies.nodeSdkShutdown;
  }
  return { NodeSDK: FakeNodeSDK };
});

vi.mock("@opentelemetry/auto-instrumentations-node", () => ({
  getNodeAutoInstrumentations: vi.fn(() => ["auto-instrs"]),
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => {
  function FakeOTLPTraceExporter(
    this: { kind: string; url: string },
    opts: { url: string },
  ) {
    spies.otlpExporterCtor(opts);
    this.kind = "otlp-http";
    this.url = opts.url;
  }
  return { OTLPTraceExporter: FakeOTLPTraceExporter };
});

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn(attrs => ({ kind: "resource", attrs })),
}));

vi.mock("@opentelemetry/sdk-trace-base", () => {
  function FakeBatchSpanProcessor() {
    spies.batchSpanProcessorCtor();
    return { kind: "batch" };
  }
  function FakeConsoleSpanExporter() {
    return { kind: "console" };
  }
  return {
    BatchSpanProcessor: FakeBatchSpanProcessor,
    ConsoleSpanExporter: FakeConsoleSpanExporter,
  };
});

vi.mock("@opentelemetry/api", () => ({
  diag: { setLogger: vi.fn() },
  DiagConsoleLogger: function DiagConsoleLogger() {
    return {};
  },
  DiagLogLevel: { INFO: "INFO", DEBUG: "DEBUG" },
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// NOTE: "../config" is NOT mocked at the top level so each test can install
// its own vi.doMock("../config", ...) before importing ./otel.js. The default
// shape (endpoint set, SDK enabled) matches the production "happy path".

import { initOtel, isOtelEnabled, shutdownOtel } from "./otel.js";

type TestConfig = {
  OTEL_SDK_DISABLED: boolean;
  OTEL_EXPORTER_OTLP_ENDPOINT: string | undefined;
  OTEL_SERVICE_NAME: string;
  OTEL_TRACE_SAMPLE_RATE: number;
  NUQ_POD_NAME: string;
  SENTRY_ENVIRONMENT: string;
};

const baseConfig: TestConfig = {
  OTEL_SDK_DISABLED: false,
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318",
  OTEL_SERVICE_NAME: "firecrawl-api",
  OTEL_TRACE_SAMPLE_RATE: 0.01,
  NUQ_POD_NAME: "test-pod",
  SENTRY_ENVIRONMENT: "test",
};

async function loadOtelWithConfig(overrides: Partial<TestConfig> = {}) {
  const cfg = { ...baseConfig, ...overrides };
  vi.doMock("../config", () => ({ config: cfg }));
  vi.resetModules();
  return import("./otel.js");
}

describe("otel", () => {
  beforeEach(() => {
    spies.nodeSdkCtor.mockClear();
    spies.nodeSdkStart.mockClear();
    spies.nodeSdkShutdown.mockClear();
    spies.otlpExporterCtor.mockClear();
    spies.batchSpanProcessorCtor.mockClear();
  });

  afterEach(() => {
    vi.doUnmock("../config");
  });

  it("starts the SDK when an OTLP endpoint is configured", async () => {
    const otel = await loadOtelWithConfig();
    const result = otel.initOtel();
    expect(result).toBe(true);
    expect(otel.isOtelEnabled()).toBe(true);
    expect(spies.nodeSdkCtor).toHaveBeenCalledTimes(1);
  });

  it("appends /v1/traces when the endpoint has no path", async () => {
    const otel = await loadOtelWithConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger.example.com:4318",
    });
    otel.initOtel();
    expect(spies.otlpExporterCtor).toHaveBeenCalledWith({
      url: "http://jaeger.example.com:4318/v1/traces",
    });
  });

  it("preserves an explicit /v1/traces path on the endpoint", async () => {
    const otel = await loadOtelWithConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal/v1/traces",
    });
    otel.initOtel();
    expect(spies.otlpExporterCtor).toHaveBeenCalledWith({
      url: "http://collector.internal/v1/traces",
    });
  });

  it("does not construct NodeSDK when OTEL_SDK_DISABLED is true", async () => {
    const otel = await loadOtelWithConfig({ OTEL_SDK_DISABLED: true });
    const result = otel.initOtel();
    expect(result).toBe(false);
    expect(otel.isOtelEnabled()).toBe(false);
    expect(spies.nodeSdkCtor).not.toHaveBeenCalled();
  });

  it("does not construct NodeSDK when the endpoint is unset", async () => {
    const otel = await loadOtelWithConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    });
    const result = otel.initOtel();
    expect(result).toBe(false);
    expect(otel.isOtelEnabled()).toBe(false);
    expect(spies.nodeSdkCtor).not.toHaveBeenCalled();
  });

  it("shutdownOtel flushes and clears the singleton", async () => {
    const otel = await loadOtelWithConfig();
    otel.initOtel();
    await otel.shutdownOtel();
    expect(spies.nodeSdkShutdown).toHaveBeenCalledTimes(1);
    expect(otel.isOtelEnabled()).toBe(false);
  });

  it("shutdownOtel is safe to call when the SDK was never started", async () => {
    const otel = await loadOtelWithConfig({ OTEL_SDK_DISABLED: true });
    await expect(otel.shutdownOtel()).resolves.toBeUndefined();
    expect(spies.nodeSdkShutdown).not.toHaveBeenCalled();
  });

  it("exposes initOtel and isOtelEnabled as public API", () => {
    expect(typeof initOtel).toBe("function");
    expect(typeof isOtelEnabled).toBe("function");
    expect(typeof shutdownOtel).toBe("function");
  });
});
