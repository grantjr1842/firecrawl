// ---------------------------------------------------------------------------
// OBS-07: the console transport in apps/api/src/lib/logger.ts must emit
// parseable JSON on stdout so that docker logs / kubectl logs / Loki promtail
// / fluentbit can ingest it without special-casing. The default behaviour
// (FIRECRAWL_LOG_FORMAT unset or =json) is exercised here; the
// human-readable printf path is gated behind FIRECRAWL_LOG_FORMAT=text.
//
// The logger module reads `config` at module-load time, so we mock the
// config module (vi.mock is hoisted above the import) and then dynamically
// import the logger inside beforeAll so that the test is self-contained
// and does not depend on whatever another test file cached in the module
// graph.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";

vi.mock("../config", () => ({
  config: {
    ENV: "production",
    SENTRY_ENVIRONMENT: "production",
    LOGGING_LEVEL: "info",
    FIRECRAWL_LOG_TO_FILE: false,
    FIRECRAWL_LOG_FORMAT: "json",
  },
}));

describe("logger console transport (OBS-07)", () => {
  let captured: string[] = [];
  let originalWrite: typeof process.stdout.write;

  beforeAll(async () => {
    vi.resetModules();
    const loggerModule = (await import("./logger.js")) as {
      logger: import("winston").Logger;
    };
    const { logger } = loggerModule;

    captured = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    // Redirect stdout writes so the test doesn't spam the vitest reporter
    // and so we can assert on every line. winston's Console transport
    // writes a single log record per write call.
    (process.stdout as unknown as { write: unknown }).write = (
      chunk: string | Uint8Array,
    ) => {
      const s =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      captured.push(s);
      return true;
    };

    // Emit a few lines that exercise the typical code paths. All should be
    // parseable JSON because the format chain ends in winston.format.json().
    logger.info("info line from OBS-07 test", { module: "logger.test" });
    logger.warn("warn line from OBS-07 test", { module: "logger.test" });
    logger.error("error line from OBS-07 test", { module: "logger.test" });
    logger.debug("debug line - should be filtered by info level");

    // Give winston a moment to drain the stream callbacks.
    await new Promise(resolve => setImmediate(resolve));
  });

  afterAll(() => {
    (process.stdout as unknown as { write: typeof originalWrite }).write =
      originalWrite;
  });

  it("emits at least one line to stdout", () => {
    expect(captured.length).toBeGreaterThan(0);
  });

  it("emits every stdout line as parseable JSON (default FIRECRAWL_LOG_FORMAT=json)", () => {
    // Join the captured chunks, then split on newlines. winston writes one
    // log record per write call, so each chunk is exactly one record, but
    // we split defensively in case a chunk contains a trailing fragment.
    const all = captured.join("");
    const lines = all
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0);

    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        // Surface a clear assertion error showing the offending line so
        // the failure is debuggable.
        throw new Error(
          `stdout line was not valid JSON: ${line.slice(0, 200)} (${
            (e as Error).message
          })`,
        );
      }
      expect(typeof parsed).toBe("object");
      expect(parsed).not.toBeNull();
    }
  });

  it("JSON lines carry the winston timestamp, level, and message fields", () => {
    const all = captured.join("");
    const lines = all
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0);
    const records = lines.map(l => JSON.parse(l) as Record<string, unknown>);

    const infoRecord = records.find(
      r => r.message === "info line from OBS-07 test",
    );
    expect(infoRecord).toBeDefined();
    expect(infoRecord).toMatchObject({
      level: "info",
      message: "info line from OBS-07 test",
    });
    expect(typeof infoRecord!.timestamp).toBe("string");

    const warnRecord = records.find(
      r => r.message === "warn line from OBS-07 test",
    );
    expect(warnRecord).toBeDefined();
    expect(warnRecord).toMatchObject({
      level: "warn",
      message: "warn line from OBS-07 test",
    });
  });

  it("does not emit debug records when the configured level is info", () => {
    const all = captured.join("");
    const lines = all
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0);
    const records = lines.map(l => JSON.parse(l) as Record<string, unknown>);
    const debugRecord = records.find(
      r => r.message === "debug line - should be filtered by info level",
    );
    expect(debugRecord).toBeUndefined();
  });

  it("does not write a firecrawl-*.log file when FIRECRAWL_LOG_TO_FILE is false", () => {
    // Sanity: the file transport should not have created a side-effect file
    // in the cwd during the test. Other parallel tests might leave one
    // behind, so we only assert that *this* test did not create a new one.
    const cwd = process.cwd();
    const entries = fs
      .readdirSync(cwd)
      .filter(f => /^firecrawl-(app|worker)\.log$/.test(f));
    expect(entries).toEqual([]);
  });
});
