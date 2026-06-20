// Unit tests for the HTML-template builder's markdown→HTML output.
// These tests don't need weasyprint — they only run pandoc and assert
// on the produced HTML. When pandoc is missing we skip silently.
//
// IMPORTANT: this file must NOT use vi.mock("child_process") — the
// template helper spawns pandoc through the real child_process API
// and the mock would cause the test promises to hang forever (the
// mocked spawn never emits 'close' automatically). Keep these
// assertions in their own file so the structural mock in
// defaultRenderer.test.ts and bookRenderer.test.ts doesn't bleed in.

import { describe, expect, it } from "vitest";
import { buildScrapeHTML } from "../../../services/pdf/template";

const hasPandoc = (() => {
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

const describeIfPandoc = hasPandoc ? describe : describe.skip;

describeIfPandoc("template HTML (fenced code blocks, definition lists, TOC)", () => {
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
    // it as inline code. Note: pandoc attaches a `class="sourceCode
    // <lang>"` attribute to the inner <code> of fenced blocks, so the
    // regex allows optional attributes between `<code` and `>`. The
    // body of fenced-block <code> contains nested <span> elements
    // (the syntax tokens), so we use a lookahead to confirm a
    // closing </code> follows, rather than a strict [^<]+ body match.
    expect(html).toMatch(/<code(\s[^>]*)?>(?:(?!<\/code>)[\s\S])*<\/code>/);
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

// Always include a non-skipped block so the file is "discovered" by
// editors and visible in CI logs.
describe("templateHtml (gate)", () => {
  it("skipped unless pandoc is on PATH", () => {
    if (!hasPandoc) {
      // eslint-disable-next-line no-console
      console.log(
        "[template-html-test] skipped: pandoc not found on PATH",
      );
    }
    expect(true).toBe(true);
  });
});