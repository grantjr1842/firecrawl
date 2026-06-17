import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => {
  const configState: {
    FIRECRAWL_DEV_TRACE?: boolean;
    FIRECRAWL_DEV_TRACE_BODY?: boolean;
    ENV?: string;
  } = {
    FIRECRAWL_DEV_TRACE: true,
    FIRECRAWL_DEV_TRACE_BODY: false,
    ENV: "development",
  };
  const childLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  childLogger.child = vi.fn(() => childLogger);
  const rootLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => childLogger),
  };
  return {
    configState,
    rootLogger,
    childLogger,
  };
});

vi.mock("../../config", () => ({
  get config() {
    return mocks.configState;
  },
}));

vi.mock("winston", () => {
  // Minimal stand-in for the winston surface that logger.ts uses:
  //   - format() called as a function (zeroDataRetentionFilter) returning a
  //     *callable* format object (winston treats formats as functions)
  //   - format.{json, combine, timestamp, metadata, colorize, printf}
  //   - transports.{File, Console}
  //   - createLogger()
  // We only need createLogger() to return a stub whose .info/.warn/etc.
  // are observable; the format functions are not invoked because
  // devTrace calls logger.info directly.
  const makeFormat = (() => {
    const fn = ((..._args: unknown[]) => fn) as unknown as ((
      ...args: unknown[]
    ) => unknown) & {
      json: typeof makeFormat;
      combine: (...args: unknown[]) => unknown;
      timestamp: typeof makeFormat;
      metadata: typeof makeFormat;
      colorize: typeof makeFormat;
      printf: typeof makeFormat;
    };
    return fn;
  })();
  const formatFn = makeFormat as unknown as ((
    ...args: unknown[]
  ) => unknown) & {
    json: typeof makeFormat;
    combine: (...args: unknown[]) => unknown;
    timestamp: typeof makeFormat;
    metadata: typeof makeFormat;
    colorize: typeof makeFormat;
    printf: typeof makeFormat;
  };
  formatFn.json = makeFormat;
  formatFn.combine = (..._args: unknown[]) => makeFormat();
  formatFn.timestamp = makeFormat;
  formatFn.metadata = makeFormat;
  formatFn.colorize = makeFormat;
  formatFn.printf = makeFormat;
  return {
    format: formatFn,
    transports: {
      File: vi.fn(),
      Console: vi.fn(),
    },
    createLogger: () => mocks.rootLogger,
  };
});

vi.mock("dotenv", () => ({
  configDotenv: () => ({}),
  default: { config: () => ({}) },
  config: () => ({}),
}));

import { devTrace } from "../../lib/logger";

describe("devTrace", () => {
  beforeEach(() => {
    mocks.rootLogger.info.mockClear();
    mocks.rootLogger.warn.mockClear();
    mocks.rootLogger.error.mockClear();
    mocks.rootLogger.debug.mockClear();
  });

  afterEach(() => {
    mocks.configState.FIRECRAWL_DEV_TRACE = true;
    mocks.configState.FIRECRAWL_DEV_TRACE_BODY = false;
    mocks.configState.ENV = "development";
  });

  it("emits nothing when FIRECRAWL_DEV_TRACE=false", () => {
    mocks.configState.FIRECRAWL_DEV_TRACE = false;
    devTrace("scrape.received", { jobId: "abc-123" });
    expect(mocks.rootLogger.info).not.toHaveBeenCalled();
  });

  it("emits a structured info event when FIRECRAWL_DEV_TRACE=true", () => {
    mocks.configState.FIRECRAWL_DEV_TRACE = true;
    mocks.configState.ENV = "development";
    devTrace("scrape.received", { jobId: "abc-123", teamId: "t1" });
    expect(mocks.rootLogger.info).toHaveBeenCalledTimes(1);
    const [message, payload] = mocks.rootLogger.info.mock.calls[0];
    expect(message).toBe("devTrace");
    expect(payload.event).toBe("scrape.received");
    expect(payload.jobId).toBe("abc-123");
    expect(payload.teamId).toBe("t1");
    expect(typeof payload.ts).toBe("string");
    expect(() => new Date(payload.ts as string).toISOString()).not.toThrow();
  });

  it("auto-disables when ENV=production and config is unset", () => {
    mocks.configState.FIRECRAWL_DEV_TRACE = undefined;
    mocks.configState.ENV = "production";
    devTrace("scrape.complete", { jobId: "x" });
    expect(mocks.rootLogger.info).not.toHaveBeenCalled();
  });

  it("auto-enables in non-production envs when config is unset", () => {
    mocks.configState.FIRECRAWL_DEV_TRACE = undefined;
    mocks.configState.ENV = "staging";
    devTrace("scrape.complete", { jobId: "x" });
    expect(mocks.rootLogger.info).toHaveBeenCalledTimes(1);
  });

  it("includes the first 4KB of 'body' field when FIRECRAWL_DEV_TRACE_BODY=true", () => {
    mocks.configState.FIRECRAWL_DEV_TRACE = true;
    mocks.configState.FIRECRAWL_DEV_TRACE_BODY = true;
    const small = "a".repeat(2_000);
    devTrace("scrape.transform.start", { jobId: "j1", body: small });
    expect(mocks.rootLogger.info).toHaveBeenCalledTimes(1);
    const [, payload] = mocks.rootLogger.info.mock.calls[0];
    expect(payload.body).toBe(small);
  });

  it("truncates oversized 'body' field to 4KB", () => {
    mocks.configState.FIRECRAWL_DEV_TRACE = true;
    mocks.configState.FIRECRAWL_DEV_TRACE_BODY = true;
    const huge = "b".repeat(10_000);
    devTrace("scrape.transform.start", { jobId: "j1", body: huge });
    expect(mocks.rootLogger.info).toHaveBeenCalledTimes(1);
    const [, payload] = mocks.rootLogger.info.mock.calls[0];
    expect((payload.body as string).length).toBe(
      4 * 1024 + "...[truncated]".length,
    );
    expect((payload.body as string).endsWith("...[truncated]")).toBe(true);
  });

  it("does not touch 'body' when FIRECRAWL_DEV_TRACE_BODY is unset", () => {
    mocks.configState.FIRECRAWL_DEV_TRACE = true;
    mocks.configState.FIRECRAWL_DEV_TRACE_BODY = false;
    const body = "raw bytes that would be too long".repeat(1_000);
    devTrace("scrape.fetch.start", { jobId: "j1", body });
    const [, payload] = mocks.rootLogger.info.mock.calls[0];
    expect(payload.body).toBe(body);
  });

  it("does not construct the payload object when disabled", () => {
    mocks.configState.FIRECRAWL_DEV_TRACE = false;
    const explosive: Record<string, unknown> = Object.defineProperty(
      {},
      "boom",
      {
        get() {
          throw new Error("devTrace constructed payload when disabled");
        },
      },
    );
    expect(() => devTrace("scrape.complete", explosive)).not.toThrow();
    expect(mocks.rootLogger.info).not.toHaveBeenCalled();
  });
});
