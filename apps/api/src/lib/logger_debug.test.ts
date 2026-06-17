import { vi } from "vitest";

vi.mock("../config", () => ({
  config: {
    ENV: "production",
    SENTRY_ENVIRONMENT: "production",
    LOGGING_LEVEL: "info",
    FIRECRAWL_LOG_TO_FILE: false,
    FIRECRAWL_LOG_FORMAT: "json",
  },
}));

describe("debug", () => {
  it("logs to stdout", async () => {
    vi.resetModules();
    const mod = (await import("./logger.js")) as { logger: any };
    const { logger } = mod;
    process.stderr.write("LEVEL: " + logger.level + "\n");
    process.stderr.write("transports: " + logger.transports.map((t: any) => t.name).join(",") + "\n");
    const t0 = logger.transports[0];
    process.stderr.write("transport ctor: " + t0.constructor.name + " stream=" + !!t0.stream + "\n");
    if (t0.stream) {
      process.stderr.write("stream ctor: " + t0.stream.constructor.name + "\n");
    }
    logger.info("hello world", { module: "x" });
    await new Promise(r => setImmediate(r));
  });
});
