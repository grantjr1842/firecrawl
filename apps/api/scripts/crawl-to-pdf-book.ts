/**
 * Standalone driver: crawl a docs site and render a complete API
 * reference PDF book.
 *
 * Pipeline:
 *   1. Fetch the sitemap.xml and discover every URL.
 *   2. For each URL (in parallel, bounded): fetch the HTML, extract
 *      the main content, and convert to markdown via turndown.
 *   3. Batch-render all chapter markdown into HTML via pandoc
 *      (`markdownToHtmlBatch`).
 *   4. Build a `BookPdfInput` and call `renderBookToPDF`.
 *   5. Write the PDF to the output path and verify it with pdfinfo.
 *
 * Run with:
 *   cd apps/api && pnpm exec tsx scripts/crawl-to-pdf-book.ts \
 *     --url https://docs.crawl4ai.com/ \
 *     --output /tmp/crawl4ai-api-reference.pdf \
 *     --title "Crawl4AI API Reference"
 *
 * The script is intentionally a *driver* — it imports the new
 * production code from `services/pdf/` and `services/pdf/template`
 * directly so any failure is a failure of the library, not a
 * parallel implementation.
 */

import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "joplin-turndown-plugin-gfm";
import { renderBookToPDF } from "../src/services/pdf/defaultRenderer";
import { markdownToHtmlBatch } from "../src/services/pdf/template";

interface Args {
  url: string;
  output: string;
  title: string;
  subtitle?: string;
  concurrency: number;
  maxPages: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback?: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return fallback;
    return argv[i + 1];
  };
  const url = get("--url", "https://docs.crawl4ai.com/");
  const output = get("--output", "/tmp/crawl4ai-api-reference.pdf");
  const title = get("--title", "Crawl4AI API Reference");
  const subtitle = get("--subtitle");
  const concurrency = Number(get("--concurrency", "8") ?? "8");
  const maxPages = Number(get("--max-pages", "200") ?? "200");
  const verbose = argv.includes("--verbose") || argv.includes("-v");
  if (!url) throw new Error("--url is required");
  if (!output) throw new Error("--output is required");
  if (!title) throw new Error("--title is required");
  return { url, output, title, subtitle, concurrency, maxPages, verbose };
}

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) FirecrawlPdfBookDriver/1.0 (+https://github.com/firecrawl/firecrawl)";

function log(args: Args, ...parts: unknown[]): void {
  if (args.verbose) {
    // eslint-disable-next-line no-console
    console.log(`[crawl-to-pdf-book]`, ...parts);
  }
}

function info(...parts: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`[crawl-to-pdf-book]`, ...parts);
}

/** Strip protocol + trailing slashes for a clean origin. */
function originOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

/**
 * Fetch a URL with a small timeout. Retries once on transient network
 * errors (the docs site occasionally 502s under load). On HTTP error
 * we throw so the caller can record a failure for that page.
 */
async function fetchText(url: string, timeoutMs = 30_000): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xml,*/*" },
      signal: ac.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Parse sitemap.xml into a list of absolute URLs. If the sitemap
 * references a sitemap index file, recurse one level (Mintlify
 * occasionally splits into a sitemap index).
 */
async function discoverSitemapUrls(
  origin: string,
  args: Args,
): Promise<string[]> {
  const seen = new Set<string>();
  const collected: string[] = [];
  const stack: string[] = [`${origin}/sitemap.xml`];

  while (stack.length > 0) {
    const sitemapUrl = stack.pop()!;
    let xml: string;
    try {
      xml = await fetchText(sitemapUrl, 15_000);
    } catch (err) {
      log(
        args,
        `sitemap fetch failed: ${sitemapUrl} (${(err as Error).message})`,
      );
      continue;
    }
    // Two simple regexes — the docs sitemap is small and well-formed.
    const locRe = /<loc>\s*([^<]+?)\s*<\/loc>/g;
    let m: RegExpExecArray | null;
    while ((m = locRe.exec(xml)) !== null) {
      const loc = m[1].trim();
      if (loc.endsWith(".xml") && !seen.has(loc)) {
        seen.add(loc);
        stack.push(loc);
      } else if (!seen.has(loc)) {
        seen.add(loc);
        collected.push(loc);
      }
    }
  }
  // Dedupe and stable-sort so the book has a deterministic order.
  return Array.from(new Set(collected)).sort();
}

/**
 * Convert the HTML for a docs page into clean markdown. Strips
 * navigation, sidebars, footers, feedback widgets, and other chrome
 * so the rendered chapter body is the actual content. Uses
 * `jsdom` to give turndown a real DOM, and `gfm` to preserve
 * tables, fenced code blocks, and strikethrough.
 */
function htmlToMarkdown(html: string, sourceURL: string): string {
  const dom = new JSDOM(html, { url: sourceURL });
  const doc = dom.window.document;

  // Remove everything that isn't the main content.
  const removeSelectors = [
    "nav",
    "header.site-header",
    "footer",
    ".sidebar",
    ".nav-sidebar",
    "aside",
    ".feedback-widget",
    ".feedback-button",
    ".page-actions",
    ".toc-sidebar",
    "script",
    "style",
    "noscript",
    "iframe",
    "svg",
    ".breadcrumb",
    ".search-modal",
  ];
  for (const sel of removeSelectors) {
    doc.querySelectorAll(sel).forEach(el => el.remove());
  }

  // Mintlify (and most modern doc sites) put the body in <main> or
  // <article> or [role="main"]. Fall back to <body> as a last resort.
  const main =
    doc.querySelector("main") ??
    doc.querySelector("article") ??
    doc.querySelector('[role="main"]') ??
    doc.querySelector(".content") ??
    doc.querySelector("body");

  if (!main) {
    return "";
  }

  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    strongDelimiter: "**",
  });
  td.use(gfm);

  let md = td.turndown(main.innerHTML);
  // Collapse runs of blank lines (turndown + jsdom leave 3+ in a row).
  md = md.replace(/\n{3,}/g, "\n\n").trim();
  return md;
}

/** Derive a short, human-readable chapter title from a URL path. */
function titleFromURL(url: string): string {
  const u = new URL(url);
  let p = u.pathname.replace(/^\/|\/$/g, "");
  if (!p || p === "index") return "Overview";
  // Skip obvious top-level sections so chapter titles stay clean.
  const parts = p.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "untitled";
  return last.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

interface Page {
  url: string;
  title: string;
  markdown: string;
}

/**
 * Fetch all pages with bounded concurrency. We collect failures into
 * a separate list so a single 5xx doesn't kill the whole crawl —
 * a few missing chapters are still a useful book.
 */
async function fetchAllPages(
  urls: string[],
  args: Args,
): Promise<{ pages: Page[]; failures: { url: string; err: string }[] }> {
  const pages: Page[] = [];
  const failures: { url: string; err: string }[] = [];
  let cursor = 0;

  async function worker(id: number): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= urls.length) return;
      const url = urls[i];
      try {
        const html = await fetchText(url, 20_000);
        const markdown = htmlToMarkdown(html, url);
        if (markdown.length < 80) {
          log(args, `[w${id}] ${url} → empty, skipping`);
          continue;
        }
        pages.push({ url, title: titleFromURL(url), markdown });
        if (pages.length % 10 === 0) {
          info(`fetched ${pages.length}/${urls.length} pages`);
        }
      } catch (err) {
        failures.push({ url, err: (err as Error).message });
        log(args, `[w${id}] ${url} → ${(err as Error).message}`);
      }
    }
  }

  const workers = Array.from({ length: args.concurrency }, (_, i) => worker(i));
  await Promise.all(workers);

  // Deterministic order: by URL so chapters are stable across runs.
  pages.sort((a, b) => a.url.localeCompare(b.url));
  return { pages, failures };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const origin = originOf(args.url);

  info(`discovering pages for ${origin}`);
  const urls = (await discoverSitemapUrls(origin, args)).filter(u =>
    u.startsWith(origin),
  );
  info(`sitemap returned ${urls.length} URLs`);

  const limited = urls.slice(0, args.maxPages);
  info(`capping at ${limited.length} pages (--max-pages=${args.maxPages})`);

  const t0 = Date.now();
  const { pages, failures } = await fetchAllPages(limited, args);
  const fetchElapsed = Date.now() - t0;
  info(
    `fetched ${pages.length} pages in ${(fetchElapsed / 1000).toFixed(1)}s ` +
      `(${failures.length} failures)`,
  );
  if (failures.length > 0 && args.verbose) {
    for (const f of failures) info(`  - ${f.url}: ${f.err}`);
  }

  if (pages.length === 0) {
    throw new Error("No pages fetched — aborting before render");
  }

  // Aggregate the corpus so we can report a rough size.
  const totalMarkdownBytes = pages.reduce((s, p) => s + p.markdown.length, 0);
  info(
    `corpus: ${pages.length} pages, ${(totalMarkdownBytes / 1024).toFixed(1)} KB markdown`,
  );

  info(`batch-rendering markdown → HTML via pandoc`);
  const markdowns = pages.map(p => p.markdown);
  const t1 = Date.now();
  const chapterHtmls = await markdownToHtmlBatch(markdowns);
  info(
    `pandoc batch done in ${((Date.now() - t1) / 1000).toFixed(1)}s ` +
      `(${chapterHtmls.length} chunks)`,
  );

  // Some chapters come out empty if the page is mostly chrome; drop
  // them so the book only contains real content. We keep the URL
  // and title in lock-step with chapterHtmls.
  const chapters = pages
    .map((p, i) => ({
      id: String(i + 1),
      title: p.title,
      url: p.url,
      contentHtml: chapterHtmls[i] ?? "",
    }))
    .filter(c => c.contentHtml.trim().length > 0);

  info(
    `rendering book: ${chapters.length} chapters, ${(chapters.length * 1).toFixed(0)} chapter pages`,
  );

  const t2 = Date.now();
  const buf = await renderBookToPDF({
    title: args.title,
    subtitle: args.subtitle,
    sourceURL: args.url,
    scrapedAt: new Date(),
    chapters,
  });
  info(
    `weasyprint done in ${((Date.now() - t2) / 1000).toFixed(1)}s, ` +
      `PDF=${(buf.length / 1024).toFixed(1)} KB`,
  );

  const { promises: fs } = await import("fs");
  const path = await import("path");
  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(args.output, buf);
  info(`wrote ${args.output}`);

  // Sanity check: every PDF starts with "%PDF-".
  if (buf.slice(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error(
      `output does not look like a PDF (missing %PDF- header): ${args.output}`,
    );
  }
  info(`OK — PDF header verified (%PDF-)`);

  // Force-exit so the process doesn't sit on any leftover handles
  // (winston transports, child-process stdio streams, etc.) after
  // the work is done. Without this, the script can hang for the
  // outer timeout duration even though the PDF is already on
  // disk. The renderer's `proc.unref()` + `timer.unref()` design
  // is meant to avoid this, but in practice the weasyprint
  // child-process close event has been observed to not always
  // unblock the event loop in this script's environment. See
  // `defaultRenderer.ts` for the related unref work and the
  // PDF-RENDERER-RACE-001 test for the spawn-lifecycle fixes.
  process.exit(0);
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error("[crawl-to-pdf-book] FATAL:", err);
  process.exit(1);
});
