import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { config } from "../../config";
import { devTrace } from "../../lib/logger";
import { buildBookHTML, buildScrapeHTML, ScrapePdfInput } from "./template";
import type { BookPdfInput } from "./template";

/**
 * Default PDF renderer: markdown → HTML via pandoc → PDF via weasyprint.
 *
 * Design:
 *   1. Build a self-contained HTML document with the inlined template
 *      and CSS (no CDN, no external resources, fully offline).
 *   2. Write it to a temp .html file in os.tmpdir().
 *   3. Spawn the system `weasyprint` binary to render HTML → PDF.
 *   4. Read the PDF buffer back from disk and clean up.
 *
 * The temp files are always cleaned up, even on error, via try/finally.
 * We also honour `PDF_RENDER_TIMEOUT_MS` so a stuck weasyprint process
 * can't hold a worker hostage.
 *
 * Why we use the CLI rather than the Python API:
 *   - The Python API requires a Python interpreter in the runtime image
 *     and a system-installed weasyprint. Invoking the CLI is one process
 *     boundary instead of two, easier to install and to swap out.
 *   - The CLI's exit code, stdout, and stderr give us a clean failure
 *     surface — easier to surface "weasyprint is missing" vs "render
 *     failed" distinctly.
 */
export async function renderScrapeToPDF(
  input: ScrapePdfInput,
): Promise<Buffer> {
  const startedAt = Date.now();
  const correlationId = `pdf-${startedAt.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  devTrace("pdf.render.start", {
    correlationId,
    sourceURL: input.sourceURL,
    markdownBytes: input.markdown?.length ?? 0,
    hasScreenshot: !!input.screenshot,
    linkCount: input.links?.length ?? 0,
    renderer: "weasyprint",
  });

  let htmlPath: string | null = null;
  let pdfPath: string | null = null;

  try {
    // 1. Build the HTML (this also runs pandoc under the hood).
    const html = await buildScrapeHTML(input);
    devTrace("pdf.template.built", {
      correlationId,
      htmlBytes: html.length,
    });

    // 2. Write to a temp file.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "firecrawl-pdf-"));
    htmlPath = path.join(tmpDir, "input.html");
    pdfPath = path.join(tmpDir, "output.pdf");
    await fs.writeFile(htmlPath, html, "utf8");
    devTrace("pdf.temp.written", {
      correlationId,
      htmlPath,
      pdfPath,
      tmpDir,
    });

    // 3. Spawn weasyprint.
    const result = await runWeasyprint(htmlPath, pdfPath, correlationId);

    // 4. Read the PDF bytes back.
    const pdf = await fs.readFile(pdfPath);

    devTrace("pdf.render.success", {
      correlationId,
      pdfBytes: pdf.length,
      durationMs: Date.now() - startedAt,
    });
    return result ?? pdf;
  } catch (err) {
    devTrace("pdf.render.error", {
      correlationId,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    // Best-effort cleanup. We use the directory both files live in so
    // we don't have to track them individually if either path failed.
    if (htmlPath) {
      const dir = path.dirname(htmlPath);
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // ignore — tmpdir reaper will catch it
      }
    }
  }
}

/**
 * Render a multi-chapter "book" PDF. Mirrors `renderScrapeToPDF` —
 * the same write-temp + spawn-weasyprint + read-back pipeline, but
 * the HTML comes from `buildBookHTML` instead of `buildScrapeHTML`.
 * Used for API-reference-book mode where each chapter is its own
 * page.
 */
export async function renderBookToPDF(input: BookPdfInput): Promise<Buffer> {
  const startedAt = Date.now();
  const correlationId = `book-pdf-${startedAt.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  devTrace("pdf.book.render.start", {
    correlationId,
    sourceURL: input.sourceURL,
    chapterCount: input.chapters.length,
    renderer: "weasyprint",
  });

  let htmlPath: string | null = null;
  let pdfPath: string | null = null;

  try {
    const html = await buildBookHTML(input);
    devTrace("pdf.book.template.built", {
      correlationId,
      htmlBytes: html.length,
      chapterCount: input.chapters.length,
    });

    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "firecrawl-book-pdf-"),
    );
    htmlPath = path.join(tmpDir, "input.html");
    pdfPath = path.join(tmpDir, "output.pdf");
    await fs.writeFile(htmlPath, html, "utf8");
    devTrace("pdf.book.temp.written", {
      correlationId,
      htmlPath,
      pdfPath,
      tmpDir,
    });

    await runWeasyprint(htmlPath, pdfPath, correlationId);

    const pdf = await fs.readFile(pdfPath);
    devTrace("pdf.book.render.success", {
      correlationId,
      pdfBytes: pdf.length,
      durationMs: Date.now() - startedAt,
    });
    return pdf;
  } catch (err) {
    devTrace("pdf.book.render.error", {
      correlationId,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    if (htmlPath) {
      const dir = path.dirname(htmlPath);
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // ignore — tmpdir reaper will catch it
      }
    }
  }
}

/**
 * Internal helper: invoke weasyprint and resolve on success. Returns
 * the PDF buffer on success; throws on any non-zero exit, spawn error,
 * or timeout. The buffer is read here so the caller doesn't have to
 * know about the temp file layout.
 */
async function runWeasyprint(
  htmlPath: string,
  pdfPath: string,
  correlationId: string,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const weasyprintBin = process.env.WEASYPRINT_BIN ?? "/usr/bin/weasyprint";
    const proc = spawn(weasyprintBin, [htmlPath, pdfPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(
        new Error(
          `weasyprint timed out after ${config.PDF_RENDER_TIMEOUT_MS}ms (correlationId=${correlationId})`,
        ),
      );
    }, config.PDF_RENDER_TIMEOUT_MS);

    proc.on("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `weasyprint failed to start: ${err.message}. ` +
            `Is weasyprint installed at ${weasyprintBin}?`,
        ),
      );
    });

    proc.on("close", async code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(
          new Error(
            `weasyprint exited with code ${code} (correlationId=${correlationId}): ${stderr.slice(
              0,
              4000,
            )}`,
          ),
        );
        return;
      }

      try {
        const pdf = await fs.readFile(pdfPath);
        devTrace("pdf.weasyprint.success", {
          correlationId,
          pdfBytes: pdf.length,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length,
        });
        resolve(pdf);
      } catch (err) {
        reject(
          new Error(
            `weasyprint exited 0 but PDF not found at ${pdfPath}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
    });
  });
}
