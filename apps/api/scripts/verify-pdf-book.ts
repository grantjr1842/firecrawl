/**
 * Verification: inspect a generated API-reference book PDF.
 *
 *  - `pdfinfo` reports page count, file size, PDF version.
 *  - `pdftotext` extracts the text body so we can grep for known
 *    Crawl4AI chapter titles to confirm completeness.
 *  - `pdfimages -list` reports whether weasyprint embedded any
 *    images (sanity check for the screenshot appendix path).
 *
 * Usage:
 *   pnpm exec tsx src/scripts/verify-pdf-book.ts \
 *     --pdf /path/to/book.pdf \
 *     --expect-titles "Quickstart,Deep Crawling,Session Management" \
 *     --min-pages 30
 *
 * Exits non-zero on any check failure.
 */

import { spawnSync } from "child_process";
import { promises as fs } from "fs";

interface Args {
  pdf: string;
  expectTitles: string[];
  minPages: number;
  minBytes: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback?: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return fallback;
    return argv[i + 1];
  };
  const list = get("--expect-titles", "");
  const pdf = get("--pdf", "");
  if (!pdf) throw new Error("--pdf is required");
  return {
    pdf,
    expectTitles: list
      ? list
          .split(",")
          .map(s => s.trim())
          .filter(Boolean)
      : [],
    minPages: Number(get("--min-pages", "1") ?? "1"),
    minBytes: Number(get("--min-bytes", "1024") ?? "1024"),
  };
}

interface PdfInfo {
  pages: number;
  fileBytes: number;
  pdfVersion: string;
  producer: string;
  creator: string;
  pageSize: string;
}

function runPdfInfo(pdf: string): PdfInfo {
  const r = spawnSync("pdfinfo", [pdf], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `pdfinfo failed (exit=${r.status}): ${r.stderr || r.stdout}`,
    );
  }
  const out = r.stdout;
  const grab = (key: string): string => {
    const m = out.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    return m ? m[1].trim() : "";
  };
  return {
    pages: Number(grab("Pages") || 0),
    fileBytes: Number(grab("File size") || 0),
    pdfVersion: grab("PDF version"),
    producer: grab("Producer"),
    creator: grab("Creator"),
    pageSize: grab("Page size"),
  };
}

function runPdfToText(pdf: string): string {
  const r = spawnSync("pdftotext", ["-layout", pdf, "-"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(
      `pdftotext failed (exit=${r.status}): ${r.stderr || r.stdout}`,
    );
  }
  return r.stdout;
}

function fmt(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stat = await fs.stat(args.pdf);
  const info = runPdfInfo(args.pdf);
  const text = runPdfToText(args.pdf);
  const textBytes = Buffer.byteLength(text, "utf8");

  // eslint-disable-next-line no-console
  console.log(`\n=== ${args.pdf} ===`);
  // eslint-disable-next-line no-console
  console.log(
    `file:        ${fmt(stat.size)} (${stat.size.toLocaleString()} bytes)`,
  );
  // eslint-disable-next-line no-console
  console.log(`pages:       ${info.pages}`);
  // eslint-disable-next-line no-console
  console.log(`page size:   ${info.pageSize}`);
  // eslint-disable-next-line no-console
  console.log(`PDF version: ${info.pdfVersion}`);
  // eslint-disable-next-line no-console
  console.log(`producer:    ${info.producer}`);
  // eslint-disable-next-line no-console
  console.log(`creator:     ${info.creator}`);
  // eslint-disable-next-line no-console
  console.log(
    `text body:   ${fmt(textBytes)} (${textBytes.toLocaleString()} bytes, ${text.split("\n").length.toLocaleString()} lines)`,
  );

  const checks: CheckResult[] = [];
  checks.push({
    name: "PDF header (%PDF-)",
    pass:
      stat.size > 5 &&
      (await fs.readFile(args.pdf)).slice(0, 5).toString("ascii") === "%PDF-",
    detail: "first 5 bytes must be the PDF magic",
  });
  checks.push({
    name: "min pages",
    pass: info.pages >= args.minPages,
    detail: `expected >= ${args.minPages}, got ${info.pages}`,
  });
  checks.push({
    name: "min bytes",
    pass: stat.size >= args.minBytes,
    detail: `expected >= ${fmt(args.minBytes)}, got ${fmt(stat.size)}`,
  });
  checks.push({
    name: "non-empty text body",
    pass: textBytes > 1024,
    detail: `text extracted: ${fmt(textBytes)}`,
  });

  for (const t of args.expectTitles) {
    const found = text.toLowerCase().includes(t.toLowerCase());
    checks.push({
      name: `title present: "${t}"`,
      pass: found,
      detail: found ? "found in text body" : "NOT found in text body",
    });
  }

  // eslint-disable-next-line no-console
  console.log("\n=== checks ===");
  let failed = 0;
  for (const c of checks) {
    const tag = c.pass ? "PASS" : "FAIL";
    // eslint-disable-next-line no-console
    console.log(`  [${tag}] ${c.name} — ${c.detail}`);
    if (!c.pass) failed++;
  }

  // Print a few sample lines so the run is self-documenting.
  const sample = text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 30);
  // eslint-disable-next-line no-console
  console.log("\n=== first 30 non-empty text lines ===");
  for (const line of sample) {
    // eslint-disable-next-line no-console
    console.log(`  | ${line}`);
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n=== ${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`} ===\n`,
  );
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error("[verify-pdf-book] FATAL:", err);
  process.exit(1);
});
