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
import { buildScrapeHTML } from "../../../services/pdf/template";

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

// HTML-template-only assertions. These don't need weasyprint — they
// run pandoc (if available) and assert on the produced HTML. When
// pandoc is missing we skip silently; the structural assertions are
// still valuable in any environment with pandoc.
const hasPandocForTemplate = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const out = require("child_process")
      .execSync("command -v pandoc", {
        stdio: ["ignore", "pipe", "ignore"],
      })
      .toString()
      .trim();
    return out.length > 0;
  } catch {
    return false;
  }
})();

const describeIfPandoc = hasPandocForTemplate ? describe : describe.skip;

describeIfPandoc("defaultRenderer (template HTML)", () => {
  it("renders fenced code blocks as <pre class=\"sourceCode\"> with syntax tokens", async () => {
    const html = await buildScrapeHTML({
      markdown: [
        "# Code Example",
        "",
        "Here is a snippet:",
        "",
        "```ts",
        "const x: number = 42;",
        "function greet(name: string) {",
        "  return `hello ${name}`;",
        "}",
        "```",
      ].join("\n"),
      metadata: {
        title: "Code Example",
        sourceURL: "https://example.com/code",
      },
      sourceURL: "https://example.com/code",
      scrapedAt: new Date("2026-06-19T00:00:00Z"),
    });

    // Pandoc emits `<pre class="sourceCode ts">` for fenced TypeScript
    // blocks when --highlight-style=pygments is on.
    expect(html).toMatch(/<pre class="sourceCode [^"]+">/);
    expect(html).toContain('class="sourceCode typescript"');
    // Inline `<code>` (used for `x` and `` `hello ${name}` `` in the
    // markdown above) must also be present so the stylesheet can style
    // it as inline code.
    expect(html).toMatch(/<code>[^<]+<\/code>/);
    // Pygments class spans must be present so syntax colors render.
    expect(html).toContain('class="kw"');
    expect(html).toContain('class="dv"');
    expect(html).toContain('class="fu"');
  });

  it("renders definition lists as <dl><dt><dd> structures", async () => {
    const html = await buildScrapeHTML({
      markdown: [
        "# Glossary",
        "",
        "Term A",
        ":   The first definition.",
        "",
        "Term B",
        ":   The second definition.",
      ].join("\n"),
      metadata: {
        title: "Glossary",
        sourceURL: "https://example.com/glossary",
      },
      sourceURL: "https://example.com/glossary",
      scrapedAt: new Date("2026-06-19T00:00:00Z"),
    });

    expect(html).toContain("<dl>");
    expect(html).toContain("<dt>Term A</dt>");
    expect(html).toContain("<dt>Term B</dt>");
    expect(html).toContain("<dd>");
    expect(html).toContain("The first definition.");
    expect(html).toContain("The second definition.");
  });

  it("TOC contains <a href=\"#anchor\"> links for each heading", async () => {
    const html = await buildScrapeHTML({
      markdown: [
        "# Top",
        "",
        "Intro paragraph.",
        "",
        "## First section",
        "",
        "Body of first section.",
        "",
        "## Second section",
        "",
        "Body of second section.",
      ].join("\n"),
      metadata: {
        title: "TOC test",
        sourceURL: "https://example.com/toc",
      },
      sourceURL: "https://example.com/toc",
      scrapedAt: new Date("2026-06-19T00:00:00Z"),
    });

    // TOC entries are wrapped as `<li><a href="#…">…</a></li>`.
    expect(html).toMatch(/<li><a href="#first-section">/);
    expect(html).toMatch(/<li><a href="#second-section">/);
    // And the corresponding h2 must carry the matching id so the link
    // actually resolves in the rendered PDF.
    expect(html).toContain('id="first-section"');
    expect(html).toContain('id="second-section"');
  });
});

// PDF-RENDERER-RACE-001: structural assertions that don't need a
// working weasyprint binary. We exercise the spawn/timer plumbing
// directly via `vi.mock("child_process")` so the assertions hold in
// CI without the binary present. vi.mock is hoisted to the top of
// the file by vitest, so it applies before any module imports.
const { EventEmitter } = require("events");

const fakeProcs: any[] = [];
const fakeReadFiles: string[] = [];

vi.mock("child_process", async () => {
  const actual =
    await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: string[]) => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      proc.kill = vi.fn();
      proc.unref = vi.fn();
      proc._cmd = cmd;
      proc._args = args;
      fakeProcs.push(proc);
      return proc;
    },
  };
});

// Helper for tests: emit 'close' on every proc currently in the
// fakeProcs list (so the renderer's promises resolve) and return
// the number of procs we closed. Always emits on ALL procs so the
// pending promises drain regardless of how many spawn calls the
// renderer made.
function settleAllProcs(code = 0): void {
  for (const proc of fakeProcs) {
    if (proc.listenerCount("close") > 0) {
      proc.emit("close", code);
    } else {
      proc.emit("error", new Error("fake-error-for-test"));
    }
  }
}

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: (path: string, ...rest: unknown[]) => {
        fakeReadFiles.push(path);
        return Promise.resolve(Buffer.from("%PDF-1.4\n%%EOF\n"));
      },
    },
  };
});

describe("defaultRenderer (PDF-RENDERER-RACE-001: spawn + timer lifecycle)", () => {
  beforeEach(() => {
    fakeProcs.length = 0;
    fakeReadFiles.length = 0;
  });

  it("the renderer's child process keeps the event loop alive until it exits", async () => {
    // BUGFIX-WEASYPRINT-CLOSE-HANG-001: an earlier version called
    // `proc.unref()` on the weasyprint child to avoid pinning the
    // event loop, but that made the "close" event unreliable and
    // caused the renderer to hang after the child had actually
    // exited. The current contract is the opposite: the child
    // MUST keep the loop alive (i.e. `proc.unref()` is NOT
    // called), and the SIGKILL timer is the only thing that
    // needs to be unref'd. This test pins both halves of that
    // contract so a future regression that re-introduces the
    // child-unref is caught immediately.
    const mod = await import("../../../services/pdf/defaultRenderer.js");
    const promise = mod
      .renderScrapeToPDF({
        markdown: "# x",
        metadata: { title: "x", sourceURL: "https://example.com/x" },
        sourceURL: "https://example.com/x",
        scrapedAt: new Date("2026-06-17T00:00:00Z"),
      })
      .catch(() => undefined);

    // Wait for the pandoc spawn to register.
    await new Promise(r => setTimeout(r, 50));
    expect(fakeProcs.length).toBe(1);
    const pandocProc = fakeProcs[0];

    // Settle pandoc so the renderer proceeds to the weasyprint
    // spawn.
    pandocProc.emit("close", 0);

    // Wait for the weasyprint spawn to register.
    await new Promise(r => setTimeout(r, 50));
    expect(fakeProcs.length).toBe(2);
    const weasyprintProc = fakeProcs[1];
    expect(weasyprintProc._cmd).toMatch(/weasyprint/);

    // The child process is intentionally NOT unref'd — see
    // BUGFIX-WEASYPRINT-CLOSE-HANG-001. A regression that
    // re-introduces `proc.unref()` here will re-introduce the
    // post-render hang. The timer is still unref'd (tested
    // elsewhere by the timer-cleared test, but the only thing
    // we can assert about it in this minimal fake harness is
    // that it exists).
    expect(weasyprintProc.unref).not.toHaveBeenCalled();

    // Settle the weasyprint spawn to release the renderer promise.
    // If the unref bug regresses, this `await` will hang and
    // the test will time out, which is exactly the failure mode
    // we want to catch.
    weasyprintProc.emit("close", 0);
    await promise;
  });

  it("no longer double-reads the rendered PDF (runWeasyprint already returns the buffer)", async () => {
    const mod = await import("../../../services/pdf/defaultRenderer.js");
    const promise = mod.renderScrapeToPDF({
      markdown: "# x",
      metadata: { title: "x", sourceURL: "https://example.com/x" },
      sourceURL: "https://example.com/x",
      scrapedAt: new Date("2026-06-17T00:00:00Z"),
    });

    // Wait for the pandoc spawn to register and close it.
    await new Promise(r => setTimeout(r, 50));
    fakeProcs[0].emit("close", 0);

    // Wait for the weasyprint spawn to register and close it.
    await new Promise(r => setTimeout(r, 50));
    fakeProcs[1].emit("close", 0);

    const buf = await promise;
    expect(Buffer.isBuffer(buf)).toBe(true);
    // Exactly one fs.readFile of the rendered PDF inside the
    // renderer. Track which files were read so a regression
    // that re-introduces a second readFile fails loudly with a
    // diff of the offending paths.
    expect(fakeReadFiles.filter(p => p.endsWith(".pdf"))).toHaveLength(1);
  });
});
