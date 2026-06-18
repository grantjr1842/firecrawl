import { spawn } from "child_process";
import { stylesCss } from "./styles.css";

/**
 * Shape of the input the PDF template builder accepts. We don't import the
 * full `Document` type from `controllers/v1/types.ts` because that would
 * pull the controller surface into a leaf service module — keep the
 * surface narrow and explicit.
 */
export interface ScrapePdfInput {
  /** The post-transformer markdown body, rendered through pandoc. */
  markdown: string;
  /** Optional raw HTML fallback. Currently unused by the template, but
   *  reserved for a future "render the raw HTML" path. */
  html?: string;
  /** Document metadata block (title, description, source URL, etc.). */
  metadata: {
    title?: string;
    description?: string;
    sourceURL?: string;
    language?: string;
    [key: string]: unknown;
  };
  /** Optional base64-encoded screenshot for the appendix. */
  screenshot?: string;
  /** Optional outbound links for the appendix. */
  links?: string[];
  /** Optional structured JSON for the metadata appendix. */
  json?: unknown;
  /** Override of the source URL. */
  sourceURL: string;
  /** Timestamp the scrape completed; used in the cover meta block. */
  scrapedAt?: Date;
}

/**
 * Run pandoc to convert markdown → standalone HTML fragment.
 *
 * We pass the markdown via stdin and read the HTML from stdout. This is
 * safer than shelling out with a temp file (no fs race, no permission
 * surprises on shared hosts) and gives us a single, atomic transform.
 *
 * `--no-highlight` keeps pandoc from inlining a syntax-highlight CSS that
 * would dwarf our own stylesheet; we rely on the in-page monospace
 * styling instead.
 */
export async function markdownToHtml(markdown: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(
      "pandoc",
      ["-f", "markdown", "-t", "html", "--no-highlight"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", err => {
      reject(
        new Error(
          `pandoc failed to start: ${err.message}. ` +
            `Is pandoc installed and on PATH?`,
        ),
      );
    });

    proc.on("close", code => {
      if (code !== 0) {
        reject(
          new Error(
            `pandoc exited with code ${code}: ${stderr.slice(0, 2000)}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });

    proc.stdin.write(markdown, "utf8");
    proc.stdin.end();
  });
}

/**
 * Escape a value for safe inclusion in an HTML attribute or text node.
 * Used for user-supplied metadata (title, description, source URL).
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the appendix-links list. Returns the inner HTML for the
 * `<ul class="links">` element. We trim very long URLs and cap the
 * list to keep the appendix bounded.
 */
function buildLinksList(links: string[] | undefined): string {
  if (!links || links.length === 0) {
    return `<li class="muted">No outbound links were captured for this scrape.</li>`;
  }
  const MAX = 200;
  const shown = links.slice(0, MAX);
  const more = links.length > MAX ? links.length - MAX : 0;
  const items = shown
    .map(
      l =>
        `<li><a href="${escapeHtml(l)}">${escapeHtml(truncate(l, 120))}</a></li>`,
    )
    .join("\n");
  const extra = more > 0
    ? `<li class="muted">…and ${more} more link${more === 1 ? "" : "s"} not shown.</li>`
    : "";
  return items + extra;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/**
 * Pretty-print a JSON value for the metadata appendix. Falls back to a
 * raw JSON.stringify on failure so the appendix never throws.
 */
function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable JSON]";
  }
}

/**
 * Build the body section from the pandoc-rendered HTML. We wrap it in
 * a `<div class="body">` and a `<section>` so the stylesheet's drop-cap
 * selectors and page break rules apply uniformly regardless of how
 * the user's markdown is structured.
 */
function buildBodySection(bodyHtml: string): string {
  return `<div class="body">
  <section>
    ${bodyHtml}
  </section>
</div>`;
}

/**
 * Build the appendices: links, metadata, screenshot (if present). The
 * screenshot is emitted as a base64 data URI so the rendered PDF is
 * fully self-contained — no external image fetches.
 */
function buildAppendices(input: ScrapePdfInput): string {
  const parts: string[] = [];

  parts.push(`<div class="appendix">
  <h1 id="appendix-links">Appendix — Links</h1>
  <ul class="links">
    ${buildLinksList(input.links)}
  </ul>
</div>`);

  const metaRows: string[] = [];
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    metaRows.push(
      `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(
        typeof value === "string" ? value : JSON.stringify(value),
      )}</td></tr>`,
    );
  }
  if (metaRows.length > 0) {
    parts.push(`<div class="appendix">
  <h1 id="appendix-metadata">Appendix — Metadata</h1>
  <table class="meta-table">
    <tbody>
      ${metaRows.join("\n      ")}
    </tbody>
  </table>
</div>`);
  }

  if (input.screenshot && input.screenshot.length > 0) {
    parts.push(`<div class="appendix">
  <h1 id="appendix-screenshot">Appendix — Screenshot</h1>
  <div class="screenshot-block">
    <img src="${escapeHtml(input.screenshot)}" alt="Page screenshot" />
  </div>
</div>`);
  }

  if (input.json !== undefined) {
    parts.push(`<div class="appendix">
  <h1 id="appendix-json">Appendix — Structured Data</h1>
  <pre class="metadata-json"><code>${escapeHtml(
    formatJson(input.json),
  )}</code></pre>
</div>`);
  }

  return parts.join("\n");
}

/**
 * Build the table of contents. Pandoc's `--toc` flag emits one for us,
 * but we hand-roll a styled one so we can control the typography,
 * counter format, and the leader-dotted page numbers.
 *
 * For the "links" we just enumerate the top-level h2/h3 in the body —
 * a coarse approximation that's correct for the vast majority of
 * scraped pages and avoids re-parsing the HTML tree.
 */
function buildTocSection(bodyHtml: string): string {
  // We can't run querySelector in this build step, so pull headings
  // out with a cheap regex over the pandoc HTML. The matches are
  // deliberately permissive — we only need the visible text and the
  // nearest id (which we generate from the text).
  const headingRe = /<h([23])[^>]*?>([\s\S]*?)<\/h\1>/gi;
  const seenIds = new Set<string>();
  const items: { level: number; text: string; id: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(bodyHtml)) !== null) {
    const level = Number(m[1]);
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    if (!text) continue;
    const id = slugify(text, seenIds);
    items.push({ level, text, id });
  }

  const lis = items
    .map(
      i =>
        `<li${i.level === 3 ? ' class="lvl-3"' : ""}><a href="#${i.id}">${escapeHtml(
          i.text,
        )}</a></li>`,
    )
    .join("\n        ");

  // We also inject matching ids back into the body so the toc links
  // actually resolve. The injection is done in buildScrapeHTML.
  return `<div class="toc">
  <h1>Table of Contents</h1>
  <div class="toc-body">
    <ul>
      ${lis || '<li class="muted">No headings found in this document.</li>'}
    </ul>
  </div>
</div>`;
}

/** Generate a URL-safe id from heading text. `seen` keeps ids unique. */
function slugify(text: string, seen: Set<string>): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || "section";
  let id = base;
  let n = 1;
  while (seen.has(id)) {
    n += 1;
    id = `${base}-${n}`;
  }
  seen.add(id);
  return id;
}

/**
 * Inject id="..." attributes onto the h2/h3 elements in the body HTML
 * so the TOC links resolve. Idempotent: skips headings that already
 * have an id.
 */
function injectHeadingIds(bodyHtml: string): string {
  const seen = new Set<string>();
  return bodyHtml.replace(
    /<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi,
    (_match, level, attrs, inner) => {
      if (/\bid\s*=/.test(attrs)) return _match;
      const text = inner.replace(/<[^>]+>/g, "").trim();
      const id = slugify(text || "section", seen);
      return `<h${level}${attrs} id="${id}">${inner}</h${level}>`;
    },
  );
}

/**
 * Build the cover page section. Title is the document title (or
 * "Untitled document" if missing), with the source URL and scrape
 * timestamp below.
 */
function buildCoverSection(input: ScrapePdfInput): string {
  const title = (input.metadata?.title ?? input.markdown.split("\n")[0] ?? "Untitled document")
    .toString()
    .replace(/^#+\s*/, "")
    .trim() || "Untitled document";
  const description = input.metadata?.description;
  const scrapedAt = (input.scrapedAt ?? new Date()).toISOString();

  // The `.src-url` element below is what feeds `string-set: source-url`
  // — it must remain in the DOM and hidden visually but printed, so
  // @bottom-left picks it up via the named string.
  return `<div class="cover">
  <div class="eyebrow">Scraped from the web</div>
  <div class="accent-rule"></div>
  <h1 class="title">${escapeHtml(title)}</h1>
  ${
    description
      ? `<div class="subtitle">${escapeHtml(description)}</div>`
      : ""
  }
  <div class="meta">
    <div class="source-url">${escapeHtml(input.sourceURL)}</div>
    <div>Captured ${escapeHtml(scrapedAt)}</div>
  </div>
  <span class="src-url" style="position: absolute; visibility: hidden;">${escapeHtml(
    input.sourceURL,
  )}</span>
</div>`;
}

/**
 * Build the full self-contained HTML document for the renderer.
 *
 * The output is a single HTML file with inlined CSS and an optional
 * data: URI screenshot — no external resources, no internet needed.
 */
export async function buildScrapeHTML(input: ScrapePdfInput): Promise<string> {
  const bodyHtml = injectHeadingIds(await markdownToHtml(input.markdown));
  const cover = buildCoverSection(input);
  const toc = buildTocSection(bodyHtml);
  const body = buildBodySection(bodyHtml);
  const appendices = buildAppendices(input);

  // The `.doc-root` wrapper carries the `string-set: source-url`
  // declaration so every page (not just the cover) prints the source
  // URL in the bottom-left footer.
  return `<!DOCTYPE html>
<html lang="${escapeHtml(input.metadata?.language ?? "en")}">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(input.metadata?.title ?? "Scrape PDF")}</title>
  <style>${stylesCss}
  .doc-root { string-set: source-url content(); }
  </style>
</head>
<body>
  <div class="doc-root">
    ${cover}
    ${toc}
    ${body}
    ${appendices}
  </div>
</body>
</html>`;
}
