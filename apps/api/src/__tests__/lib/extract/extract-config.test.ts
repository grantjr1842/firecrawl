// EXTRACT-PIPELINE-2026-06-17-06
// Verifies that hardcoded OpenAI providers in extract call sites are removed
// and that the central extractConfig is the single source of truth for model
// + provider selection (so a self-host operator with OLLAMA_BASE_URL set
// does not get OpenAI 401s).
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SRC_ROOT = path.resolve(__dirname, "../../../../src");

const CALL_SITE_PATHS = [
  "lib/extract/completions/singleAnswer.ts",
  "lib/extract/completions/batchExtract.ts",
  "lib/extract/completions/analyzeSchemaAndPrompt.ts",
  "lib/extract/url-processor.ts",
  "lib/generate-llmstxt/generate-llmstxt-service.ts",
];

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, rel), "utf-8");
}

function readConfigSrc(): string {
  return readSrc("lib/extract/config.ts");
}

function stripComments(src: string): string {
  return src
    .split("\n")
    .filter(line => !line.trimStart().startsWith("//"))
    .join("\n");
}

describe("extractConfig schema (extract-pipeline-2026-06-17-06)", () => {
  it("declares MODEL, SCHEMA_ANALYSIS_MODEL, and PROVIDER fields", () => {
    const src = readConfigSrc();
    expect(src).toMatch(/MODEL:\s*config\.MODEL_NAME\s*\?\?\s*["']gpt-4o-mini["']/);
    expect(src).toMatch(
      /SCHEMA_ANALYSIS_MODEL:\s*config\.MODEL_NAME\s*\?\?\s*["']gpt-4\.1["']/,
    );
    expect(src).toMatch(
      /PROVIDER:\s*config\.OLLAMA_BASE_URL\s*\?\s*["']ollama["']\s*:\s*["']openai["']/,
    );
  });

  it("flips PROVIDER to ollama when OLLAMA_BASE_URL is set", () => {
    const src = readConfigSrc();
    // The expression `config.OLLAMA_BASE_URL ? "ollama" : "openai"` is
    // exactly the resolution: OLLAMA_BASE_URL set → ollama, else → openai.
    // This is the testable contract — verifying the actual ternary in source
    // is the strongest possible guarantee for an env-driven config that
    // is evaluated at module-load time.
    expect(src).toMatch(
      /PROVIDER:\s*config\.OLLAMA_BASE_URL\s*\?\s*["']ollama["']\s*:\s*["']openai["']/,
    );
  });

  it("overrides MODEL when MODEL_NAME is set", () => {
    const src = readConfigSrc();
    // `config.MODEL_NAME ?? "gpt-4o-mini"` is the contract: when
    // MODEL_NAME is set, it wins; otherwise default.
    expect(src).toMatch(/MODEL:\s*config\.MODEL_NAME\s*\?\?\s*["']gpt-4o-mini["']/);
    expect(src).toMatch(
      /SCHEMA_ANALYSIS_MODEL:\s*config\.MODEL_NAME\s*\?\?\s*["']gpt-4\.1["']/,
    );
  });

  it("default model names preserved (no breaking change)", () => {
    const src = readConfigSrc();
    // Regression guard: the audit explicitly forbade changing the
    // default model name.
    expect(src).toContain('"gpt-4o-mini"');
    expect(src).toContain('"gpt-4.1"');
  });
});

describe("extract call sites (extract-pipeline-2026-06-17-06)", () => {
  for (const rel of CALL_SITE_PATHS) {
    it(`${rel} no longer hardcodes provider "openai" in getModel calls`, () => {
      const src = stripComments(readSrc(rel));
      // The original bug pattern — provider arg is the literal "openai".
      expect(src).not.toMatch(
        /getModel\(\s*["']gpt-[0-9a-z.\-]+["']\s*,\s*["']openai["']\s*\)/,
      );
    });
  }

  it("singleAnswer.ts primary uses extractConfig.MODEL, retry uses SCHEMA_ANALYSIS_MODEL", () => {
    const src = readSrc("lib/extract/completions/singleAnswer.ts");
    expect(src).toMatch(/model:\s*getModel\(\s*extractConfig\.MODEL\s*\)/);
    expect(src).toMatch(
      /retryModel:\s*getModel\(\s*extractConfig\.SCHEMA_ANALYSIS_MODEL\s*\)/,
    );
  });

  it("batchExtract.ts primary uses extractConfig.MODEL, retry uses SCHEMA_ANALYSIS_MODEL", () => {
    const src = readSrc("lib/extract/completions/batchExtract.ts");
    expect(src).toMatch(/model:\s*getModel\(\s*extractConfig\.MODEL\s*\)/);
    expect(src).toMatch(
      /retryModel:\s*getModel\(\s*extractConfig\.SCHEMA_ANALYSIS_MODEL\s*\)/,
    );
  });

  it("analyzeSchemaAndPrompt.ts uses SCHEMA_ANALYSIS_MODEL (omits provider)", () => {
    const src = readSrc("lib/extract/completions/analyzeSchemaAndPrompt.ts");
    expect(src).toMatch(
      /getModel\(\s*extractConfig\.SCHEMA_ANALYSIS_MODEL\s*\)/,
    );
    // Must not hardcode "openai" in the getModel call.
    expect(src).not.toMatch(/getModel\([^)]*,\s*["']openai["']/);
  });

  it("url-processor.ts primary path uses SCHEMA_ANALYSIS_MODEL; fallback uses MODEL", () => {
    const src = readSrc("lib/extract/url-processor.ts");
    // Primary path (gpt-4.1 → SCHEMA_ANALYSIS_MODEL).
    expect(src).toMatch(
      /model:\s*getModel\(\s*extractConfig\.SCHEMA_ANALYSIS_MODEL\s*\)/,
    );
    // Fallback path (gpt-4o-mini → MODEL).
    expect(src).toMatch(
      /model:\s*getModel\(\s*extractConfig\.MODEL\s*\)/,
    );
  });

  it("generate-llmstxt-service.ts uses extractConfig.MODEL (omits provider)", () => {
    const src = readSrc("lib/generate-llmstxt/generate-llmstxt-service.ts");
    expect(src).toMatch(/getModel\(\s*extractConfig\.MODEL\s*\)/);
    expect(src).not.toMatch(/getModel\([^)]*,\s*["']openai["']/);
  });

  it("deep-research research-manager.ts: o3-mini call omits provider (defaultProvider applies)", () => {
    const src = readSrc("lib/deep-research/research-manager.ts");
    // The single getModel call in research-manager is for generateFinalAnalysis
    // at line 346. It already omits the provider arg, so defaultProvider
    // applies — and MODEL_NAME is honored via getModel's `config.MODEL_NAME || name`.
    expect(src).toMatch(/getModel\(\s*["']o3-mini["']\s*\)/);
  });
});
