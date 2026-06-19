// Integration test for the default PDF renderer (weasyprint + pandoc).
//
// These tests shell out to the real system binaries at
// /usr/bin/weasyprint and `pandoc`. They're guarded by an env var so
// the rest of the suite can still run in environments where neither
// binary is installed (CI matrix, sandboxes, etc.). Set
// PDF_RENDERER_E2E=1 to opt in.

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderScrapeToPDF } from "../../../services/pdf/defaultRenderer";

const E2E = process.env.PDF_RENDERER_E2E === "1";

const TEST_OUTPUT = path.join(os.tmpdir(), "test-output.pdf");

const hasWeasyprint = (() => {
  try {
    // execSync returns a Buffer of stdout when stdio is "pipe" (the
    // default); with stdio: "ignore" it returns null on success — which
    // is also falsy and breaks the gate below. We want truthy on success
    // and falsy on failure, so we use `command -v` with explicit stdio
    // and coerce the stdout to a non-empty trimmed string.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const out = require("child_process")
      .execSync("command -v weasyprint", {
        stdio: ["ignore", "pipe", "ignore"],
      })
      .toString()
      .trim();
    return out.length > 0;
  } catch {
    return false;
  }
})();

const describeIfE2E = E2E && hasWeasyprint ? describe : describe.skip;

describeIfE2E("defaultRenderer (weasyprint + pandoc)", () => {
  beforeAll(() => {
    // Some debug output so the test run is self-documenting.
    // eslint-disable-next-line no-console
    console.log(
      `[pdf-e2e] weasyprint=${hasWeasyprint} E2E=${E2E} output=${TEST_OUTPUT}`,
    );
  });

  afterAll(async () => {
    // Leave the artifact for inspection unless the test explicitly
    // asked for cleanup. We deliberately don't fail the suite if the
    // file is missing — the test that owns it will already have
    // reported the failure.
  });

  it("returns a Buffer that begins with the PDF magic header", async () => {
    const buf = await renderScrapeToPDF({
      markdown: "# Hello\n\nWorld from Firecrawl.",
      metadata: {
        title: "Test",
        sourceURL: "https://example.com",
      },
      sourceURL: "https://example.com",
      scrapedAt: new Date("2026-06-17T00:00:00Z"),
    });

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    // Every PDF starts with the literal "%PDF-".
    expect(buf.slice(0, 5).toString("ascii")).toBe("%PDF-");

    // Persist for inspection (some teams eyeball the output locally).
    await fs.writeFile(TEST_OUTPUT, buf);
  }, 60_000);

  it("produces a PDF larger than 1KB (sanity check on content)", async () => {
    const buf = await renderScrapeToPDF({
      markdown: [
        "# Long Document",
        "",
        "This is the first paragraph, with enough text that the renderer",
        "has something to lay out across multiple lines and pages.",
        "",
        "## A subsection",
        "",
        "A second paragraph that adds a little more content so the",
        "renderer has more than a single line to flow.",
        "",
        "- one",
        "- two",
        "- three",
      ].join("\n"),
      metadata: {
        title: "Long Document",
        sourceURL: "https://example.com/long",
        description: "A document long enough to span multiple pages.",
      },
      sourceURL: "https://example.com/long",
      links: [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
      ],
      scrapedAt: new Date("2026-06-17T00:00:00Z"),
    });

    expect(buf.length).toBeGreaterThan(1024);

    // weasyprint 67 FlateDecode-compresses every stream including the
    // Info dictionary, so no producer/title string is grep-able in the
    // raw buffer. We assert on the two structural markers that always
    // appear at the top and bottom of a valid PDF: `%PDF-` and `%%EOF`.
    const tail = buf.slice(-1024).toString("ascii");
    expect(tail).toMatch(/%%EOF/);

    await fs.writeFile(TEST_OUTPUT, buf);
  }, 60_000);

  it("produces a multi-page PDF when given multi-page content", async () => {
    // We pack enough paragraphs that weasyprint has to break across
    // pages. The exact page count is layout-dependent and PDF streams
    // are FlateDecode-compressed by default so we cannot grep the raw
    // bytes for /Type /Page markers. Instead we assert byte size is
    // well above a single-page minimum — empirically multi-page PDFs
    // are at least ~80KB with the default template.
    const lines: string[] = ["# Multi-page Test"];
    for (let i = 0; i < 200; i += 1) {
      lines.push(
        `Paragraph ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing ` +
          `elit. Sed do eiusmod tempor incididunt ut labore et dolore magna ` +
          `aliqua. Ut enim ad minim veniam, quis nostrud exercitation.`,
      );
    }
    const buf = await renderScrapeToPDF({
      markdown: lines.join("\n\n"),
      metadata: {
        title: "Multi-page Test",
        sourceURL: "https://example.com/multi",
      },
      sourceURL: "https://example.com/multi",
      scrapedAt: new Date("2026-06-17T00:00:00Z"),
    });

    // Multi-page output is empirically 60KB+ on the default template
    // (lowered from 80KB after the cover-content-on-subsequent-pages
    // overlap fix landed — the duplicate span used to inflate the
    // encoded stream by ~10-20KB).
    expect(buf.length).toBeGreaterThan(60_000);

    await fs.writeFile(TEST_OUTPUT, buf);
  }, 90_000);
});

// Always include a non-skipped block so the test file is "discovered"
// by editors and the result is visible in CI logs.
describe("defaultRenderer (E2E gate)", () => {
  it("skipped unless PDF_RENDERER_E2E=1 and weasyprint is on PATH", () => {
    if (!E2E) {
      // eslint-disable-next-line no-console
      console.log(
        "[pdf-e2e] skipped: set PDF_RENDERER_E2E=1 to run weasyprint tests",
      );
    } else if (!hasWeasyprint) {
      // eslint-disable-next-line no-console
      console.log(
        "[pdf-e2e] skipped: weasyprint not found on PATH (apt: python3-weasyprint)",
      );
    }
    expect(true).toBe(true);
  });
});
