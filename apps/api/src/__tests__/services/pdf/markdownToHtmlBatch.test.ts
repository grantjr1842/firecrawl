// Unit test for `markdownToHtmlBatch`. Doesn't need weasyprint —
// just spawns pandoc and checks the split. Catches
// BUGFIX-PDF-BATCH-SENTINEL-001 (pandoc eating `@@…@@` as a
// citation).
//
// Run with:
//   pnpm exec vitest run src/__tests__/services/pdf/markdownToHtmlBatch.test.ts

import { describe, expect, it } from "vitest";
import { markdownToHtmlBatch } from "../../../services/pdf/template";

const hasPandoc = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const out = require("child_process")
      .execSync("command -v pandoc", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return out.length > 0;
  } catch {
    return false;
  }
})();

const describeIfPandoc = hasPandoc ? describe : describe.skip;

describeIfPandoc("markdownToHtmlBatch", () => {
  it("returns one HTML string per input, in order", async () => {
    const mds = [
      "# Alpha\n\nFirst body paragraph.",
      "# Beta\n\nSecond body paragraph.",
      "# Gamma\n\nThird body paragraph.",
    ];
    const htmls = await markdownToHtmlBatch(mds);

    expect(htmls).toHaveLength(3);

    // Each chunk must contain its own heading text and NOT the
    // siblings' heading text. This is the property that was
    // silently broken by BUGFIX-PDF-BATCH-SENTINEL-001 — the bare
    // `@@…@@` sentinel got wrapped in <span class="citation">,
    // the split never fired, and all three bodies collapsed into
    // htmls[0].
    expect(htmls[0]).toMatch(/<h1[^>]*>Alpha<\/h1>/);
    expect(htmls[0]).toContain("First body paragraph");
    expect(htmls[0]).not.toMatch(/<h1[^>]*>Beta<\/h1>/);
    expect(htmls[0]).not.toMatch(/<h1[^>]*>Gamma<\/h1>/);

    expect(htmls[1]).toMatch(/<h1[^>]*>Beta<\/h1>/);
    expect(htmls[1]).toContain("Second body paragraph");
    expect(htmls[1]).not.toMatch(/<h1[^>]*>Alpha<\/h1>/);
    expect(htmls[1]).not.toMatch(/<h1[^>]*>Gamma<\/h1>/);

    expect(htmls[2]).toMatch(/<h1[^>]*>Gamma<\/h1>/);
    expect(htmls[2]).toContain("Third body paragraph");
    expect(htmls[2]).not.toMatch(/<h1[^>]*>Alpha<\/h1>/);
    expect(htmls[2]).not.toMatch(/<h1[^>]*>Beta<\/h1>/);
  }, 30_000);

  it("handles a larger batch (regression for the docs.crawl4ai.com smoke test)", async () => {
    // 25 small chapters. The original bug collapsed all of them
    // into htmls[0], so any chapter index > 0 came back as an
    // empty string. The split must produce 25 non-empty chunks.
    const mds = Array.from({ length: 25 }, (_, i) => {
      return `# Chapter ${i + 1}\n\nThis is the body for chapter ${i + 1}.`;
    });
    const htmls = await markdownToHtmlBatch(mds);

    expect(htmls).toHaveLength(25);
    for (let i = 0; i < 25; i++) {
      expect(htmls[i], `htmls[${i}] should be non-empty`).not.toEqual("");
      expect(htmls[i], `htmls[${i}] should mention its own chapter`).toContain(
        `Chapter ${i + 1}`,
      );
      // The sentinel comment wrapper may leak into each chunk —
      // it's invisible in the rendered PDF but we tolerate it.
      expect(htmls[i]).not.toMatch(/<span class="citation"/);
    }
  }, 30_000);

  it("preserves content that contains literal `@` characters (citation-trigger regression)", async () => {
    // The original bug surfaced specifically because pandoc parses
    // `@citekey` as a citation. This input has both a bare
    // `@@…@@` token and a normal citation, so a regression would
    // wrap the sentinel in a <span class="citation"> and break
    // the split.
    const mds = [
      "# Doc A\n\nSee @smith2024 for background.",
      "# Doc B\n\nMarker @@INTERNAL@@ should not become a citation.",
    ];
    const htmls = await markdownToHtmlBatch(mds);

    expect(htmls).toHaveLength(2);
    expect(htmls[0]).toMatch(/<h1[^>]*>Doc A<\/h1>/);
    expect(htmls[1]).toMatch(/<h1[^>]*>Doc B<\/h1>/);
    // Doc B's body should be in htmls[1], not htmls[0] (i.e. the
    // split actually worked).
    expect(htmls[1]).toContain("Doc B");
    expect(htmls[0]).not.toContain("Doc B");
  }, 30_000);
});

// Always include a non-skipped block so the file is "discovered".
describe("markdownToHtmlBatch (gate)", () => {
  it("skipped unless pandoc is on PATH", () => {
    if (!hasPandoc) {
      // eslint-disable-next-line no-console
      console.log(
        "[pdf-batch-sentinel-test] skipped: pandoc not found on PATH",
      );
    }
    expect(true).toBe(true);
  });
});
