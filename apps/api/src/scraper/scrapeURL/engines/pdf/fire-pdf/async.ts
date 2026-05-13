import { Meta } from "../../..";
import { config } from "../../../../../config";
import { fetch as undiciFetch } from "undici";
import type { PDFProcessorResult } from "../types";
import type { PDFMode } from "../../../../../controllers/v2/types";
import { safeMarkdownToHtml } from "../markdownToHtml";
import {
  getPdfResultFromCache,
  savePdfResultToCache,
} from "../../../../../lib/gcs-pdf-cache";
import { scrapePDFWithFirePDF } from "../firePDF";
import { AbortManagerThrownError } from "../../../lib/abortManager";
import {
  firePdfAsyncSubmittedTotal,
  firePdfAsyncCompletedTotal,
  firePdfAsyncFallbackTotal,
  firePdfAsyncTotalDurationSeconds,
  firePdfAsyncPollCount,
  type FallbackReason,
} from "./metrics";
import {
  MIN_DEADLINE_MS,
  MAX_DEADLINE_MS,
  POLL_FLOOR_MS,
  POLL_CAP_MS,
  POLL_TIMEOUT_BUFFER_MS,
  TERMINAL_STATUSES,
  submitResponseSchema,
  pollResponseSchema,
  resultResponseSchema,
  type PollResponse,
  type ResultResponse,
} from "./schema";

type FirePdfAsyncDeps = {
  fetchImpl?: typeof undiciFetch;
  fallbackImpl?: typeof scrapePDFWithFirePDF;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  nowImpl?: () => number;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(handle);
      reject(
        signal?.reason instanceof Error ? signal.reason : new Error("Aborted"),
      );
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(handle);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Aborted"),
        );
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function nextPollDelay(
  prev: number,
  retryAfterMs: number | undefined,
): number {
  const candidate = retryAfterMs ?? Math.max(prev * 2, POLL_FLOOR_MS);
  return Math.min(POLL_CAP_MS, Math.max(POLL_FLOOR_MS, candidate));
}

function computeDeadlineMs(scrapeTimeoutMs: number | undefined): number {
  // 5min default when there's no scrape budget (CLI/tests). Anything outside
  // [5s, 30min] is clamped to satisfy the /jobs contract.
  const fallback = 5 * 60 * 1_000;
  const candidate = scrapeTimeoutMs ?? fallback;
  return Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, candidate));
}

export async function scrapePDFWithFirePDFAsync(
  meta: Meta,
  base64Content: string,
  maxPages?: number,
  pagesProcessed?: number,
  mode?: PDFMode,
  deps: FirePdfAsyncDeps = {},
): Promise<PDFProcessorResult> {
  const fetchImpl = deps.fetchImpl ?? undiciFetch;
  const fallbackImpl = deps.fallbackImpl ?? scrapePDFWithFirePDF;
  const sleep = deps.sleepImpl ?? defaultSleep;
  const now = deps.nowImpl ?? Date.now;

  const logger = meta.logger;
  const zdr = meta.internalOptions.zeroDataRetention === true;

  // Defense in depth: ZDR must never use async. Call site checks first; if
  // anything ever routes here with zdr=true, hand straight to sync.
  if (zdr) {
    return fallbackImpl(meta, base64Content, maxPages, pagesProcessed, mode);
  }

  // Mirror the sync cache layout so async/sync share cached results.
  const cacheable = mode !== "fast" && !maxPages;
  const ownVariant: string | undefined = mode === "ocr" ? "ocr" : undefined;
  const lookupVariants: (string | undefined)[] =
    mode === "ocr" ? ["ocr"] : [undefined, "ocr"];

  if (cacheable) {
    for (const variant of lookupVariants) {
      try {
        const cached = await getPdfResultFromCache(
          base64Content,
          "firepdf",
          variant,
        );
        if (cached) {
          logger.info("Using cached FirePDF result (async path)", {
            scrapeId: meta.id,
            requestedMode: mode,
            cacheVariant: variant ?? "base",
          });
          return {
            ...cached,
            pagesProcessed: cached.pagesProcessed ?? pagesProcessed,
          };
        }
      } catch (error) {
        logger.warn("Error checking FirePDF cache (async path), proceeding", {
          error,
          cacheVariant: variant ?? "base",
        });
      }
    }
  }

  meta.abort.throwIfAborted();

  const baseUrl = config.FIRE_PDF_BASE_URL;
  if (!baseUrl) {
    // Should be unreachable — call site checks this — but fall back rather
    // than crash if a route somehow bypasses the gate.
    return fallbackImpl(meta, base64Content, maxPages, pagesProcessed, mode);
  }

  const authHeader: Record<string, string> = config.FIRE_PDF_API_KEY
    ? { Authorization: `Bearer ${config.FIRE_PDF_API_KEY}` }
    : {};

  const overallStartedAt = now();
  const scrapeId = meta.id;
  const scrapeTimeoutMs = meta.abort.scrapeTimeout();
  const deadlineFromNow = computeDeadlineMs(scrapeTimeoutMs);
  const submitTime = now();
  const deadlineAt = new Date(submitTime + deadlineFromNow).toISOString();
  const pollingDeadline = submitTime + deadlineFromNow + POLL_TIMEOUT_BUFFER_MS;

  const fallback = async (
    reason: FallbackReason,
    extra: Record<string, unknown> = {},
  ): Promise<PDFProcessorResult> => {
    firePdfAsyncFallbackTotal.labels(reason).inc();
    logger.warn("FirePDF async falling back to sync /ocr", {
      scrapeId,
      reason,
      ...extra,
    });
    return fallbackImpl(meta, base64Content, maxPages, pagesProcessed, mode);
  };

  // ── Step 1: POST /jobs ────────────────────────────────────────────────
  const submitBody = {
    pdf_b64: base64Content,
    scrape_id: scrapeId,
    source: "firecrawl" as const,
    zdr: false as const,
    deadline_at: deadlineAt,
    ...(meta.internalOptions.teamId && {
      team_id: meta.internalOptions.teamId,
    }),
    ...(meta.internalOptions.crawlId && {
      crawl_id: meta.internalOptions.crawlId,
    }),
    options: {
      ...(pagesProcessed !== undefined && { pages_estimate: pagesProcessed }),
      ...(maxPages !== undefined && { max_pages: maxPages }),
      ...(mode !== undefined && { mode }),
    },
  };

  let submitStatus: number;
  let submitJson: unknown;
  try {
    const submitResp = await fetchImpl(`${baseUrl}/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader,
      },
      body: JSON.stringify(submitBody),
      signal: meta.abort.asSignal(),
    });
    submitStatus = submitResp.status;
    submitJson = await submitResp.json().catch(() => ({}));
  } catch (error) {
    if (error instanceof AbortManagerThrownError) throw error;
    return fallback("network_error", { error: String(error) });
  }

  if (submitStatus === 404) return fallback("http_404");
  if (submitStatus === 413) return fallback("http_413");
  if (submitStatus === 429) return fallback("http_429");
  if (submitStatus === 503) return fallback("http_503");

  if (submitStatus === 409) {
    logger.error("FirePDF async POST /jobs returned 409 scrape_id_conflict", {
      scrapeId,
      body: submitJson,
    });
    throw new Error(
      "fire-pdf async POST /jobs conflict: scrape_id reused with different inputs",
    );
  }

  if (submitStatus === 400) {
    logger.error("FirePDF async POST /jobs returned 400 validation error", {
      scrapeId,
      body: submitJson,
    });
    throw new Error("fire-pdf async POST /jobs validation error");
  }

  if (submitStatus !== 200 && submitStatus !== 202) {
    return fallback("http_5xx", { status: submitStatus, body: submitJson });
  }

  const submitParseResult = submitResponseSchema.safeParse(submitJson);
  if (!submitParseResult.success) {
    return fallback("http_5xx", {
      error: String(submitParseResult.error),
      body: submitJson,
      status: submitStatus,
    });
  }
  const submitParsed = submitParseResult.data;

  firePdfAsyncSubmittedTotal.labels(submitParsed.lane ?? "unknown").inc();
  logger.info("FirePDF async POST /jobs accepted", {
    scrapeId,
    status: submitParsed.status,
    httpStatus: submitStatus,
    lane: submitParsed.lane,
    deadlineAt,
  });

  // ── Step 2: poll GET /jobs/:id until terminal ─────────────────────────
  let pollJson: PollResponse;
  let pollCount = 0;

  if (submitStatus === 200 && submitParsed.status === "done") {
    // Idempotent replay — skip polling.
    pollJson = { scrape_id: submitParsed.scrape_id, status: "done" };
  } else {
    const polled = await pollUntilTerminal({
      baseUrl,
      scrapeId,
      authHeader,
      initialDelay: submitParsed.retry_after_ms ?? POLL_FLOOR_MS,
      pollingDeadline,
      meta,
      fetchImpl,
      sleep,
      now,
      fallback,
    });
    if (polled.kind === "fallback") return polled.result;
    pollJson = polled.poll;
    pollCount = polled.pollCount;
  }

  // ── Step 3: GET /jobs/:id/result ──────────────────────────────────────
  const resultJsonOrFallback = await fetchResult({
    baseUrl,
    scrapeId,
    authHeader,
    meta,
    fetchImpl,
    sleep,
    fallback,
    logger,
  });
  if (resultJsonOrFallback.kind === "fallback") return resultJsonOrFallback.result;
  const resultJson = resultJsonOrFallback.result;

  const pages =
    resultJson.pages_processed ?? pollJson.pages_processed ?? pagesProcessed;
  const durationMs = now() - overallStartedAt;
  firePdfAsyncTotalDurationSeconds.observe(durationMs / 1000);

  logger.info("FirePDF async completed", {
    scrapeId,
    durationMs,
    markdownLength: resultJson.markdown.length,
    pagesProcessed: pages,
    failedPages: resultJson.failed_pages,
    partialPages: resultJson.partial_pages,
    pollCount,
  });

  const processorResult: PDFProcessorResult & { markdown: string } = {
    markdown: resultJson.markdown,
    html: await safeMarkdownToHtml(resultJson.markdown, logger, meta.id),
    pagesProcessed: pages,
  };

  if (cacheable) {
    try {
      await savePdfResultToCache(
        base64Content,
        processorResult,
        "firepdf",
        ownVariant,
      );
    } catch (error) {
      logger.warn(
        "Error saving FirePDF async result to cache (continuing)",
        { error },
      );
    }
  }

  return processorResult;
}

// ── Helpers ──────────────────────────────────────────────────────────────

type PollDeps = {
  baseUrl: string;
  scrapeId: string;
  authHeader: Record<string, string>;
  initialDelay: number;
  pollingDeadline: number;
  meta: Meta;
  fetchImpl: typeof undiciFetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  fallback: (
    reason: FallbackReason,
    extra?: Record<string, unknown>,
  ) => Promise<PDFProcessorResult>;
};

type PollOutcome =
  | { kind: "done"; poll: PollResponse; pollCount: number }
  | { kind: "fallback"; result: PDFProcessorResult };

async function pollUntilTerminal(deps: PollDeps): Promise<PollOutcome> {
  const {
    baseUrl,
    scrapeId,
    authHeader,
    pollingDeadline,
    meta,
    fetchImpl,
    sleep,
    now,
    fallback,
  } = deps;
  let pollCount = 0;
  let lastDelay = deps.initialDelay;

  while (true) {
    if (now() > pollingDeadline) {
      firePdfAsyncPollCount.observe(pollCount);
      return {
        kind: "fallback",
        result: await fallback("polling_timeout", { pollCount }),
      };
    }

    meta.abort.throwIfAborted();
    await sleep(lastDelay, meta.abort.asSignal());
    pollCount++;

    let pollResp;
    try {
      pollResp = await fetchImpl(`${baseUrl}/jobs/${scrapeId}`, {
        method: "GET",
        headers: { ...authHeader },
        signal: meta.abort.asSignal(),
      });
    } catch (error) {
      if (error instanceof AbortManagerThrownError) throw error;
      firePdfAsyncPollCount.observe(pollCount);
      return {
        kind: "fallback",
        result: await fallback("network_error", {
          error: String(error),
          pollCount,
        }),
      };
    }

    const pollStatus = pollResp.status;
    const pollBody = await pollResp.json().catch(() => ({}));

    if (pollStatus === 404) {
      firePdfAsyncPollCount.observe(pollCount);
      throw new Error(
        "fire-pdf async GET /jobs/:id 404: scrape_id missing after successful submit",
      );
    }

    if (pollStatus === 410) {
      firePdfAsyncPollCount.observe(pollCount);
      const parsed = pollResponseSchema.safeParse(pollBody);
      const status = parsed.success ? parsed.data.status : "expired";
      firePdfAsyncCompletedTotal.labels(status).inc();
      return {
        kind: "fallback",
        result: await fallback(
          status === "cancelled" ? "terminal_cancelled" : "terminal_expired",
          { status, pollCount, body: pollBody },
        ),
      };
    }

    if (pollStatus === 502) {
      firePdfAsyncPollCount.observe(pollCount);
      firePdfAsyncCompletedTotal.labels("failed").inc();
      return {
        kind: "fallback",
        result: await fallback("terminal_failed", { pollCount, body: pollBody }),
      };
    }

    if (pollStatus !== 200 && pollStatus !== 202) {
      firePdfAsyncPollCount.observe(pollCount);
      return {
        kind: "fallback",
        result: await fallback("http_5xx", {
          status: pollStatus,
          body: pollBody,
          pollCount,
        }),
      };
    }

    const parsed = pollResponseSchema.safeParse(pollBody);
    if (!parsed.success) {
      firePdfAsyncPollCount.observe(pollCount);
      return {
        kind: "fallback",
        result: await fallback("http_5xx", {
          error: String(parsed.error),
          body: pollBody,
          pollCount,
        }),
      };
    }

    if (TERMINAL_STATUSES.has(parsed.data.status)) {
      firePdfAsyncPollCount.observe(pollCount);
      firePdfAsyncCompletedTotal.labels(parsed.data.status).inc();
      if (parsed.data.status !== "done") {
        const reason: FallbackReason =
          parsed.data.status === "failed"
            ? "terminal_failed"
            : parsed.data.status === "expired"
              ? "terminal_expired"
              : "terminal_cancelled";
        return {
          kind: "fallback",
          result: await fallback(reason, {
            status: parsed.data.status,
            errorClass: parsed.data.error_class,
            errorMessage: parsed.data.error_message,
            pollCount,
          }),
        };
      }
      return { kind: "done", poll: parsed.data, pollCount };
    }

    lastDelay = nextPollDelay(lastDelay, parsed.data.retry_after_ms);
  }
}

type ResultDeps = {
  baseUrl: string;
  scrapeId: string;
  authHeader: Record<string, string>;
  meta: Meta;
  fetchImpl: typeof undiciFetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  fallback: (
    reason: FallbackReason,
    extra?: Record<string, unknown>,
  ) => Promise<PDFProcessorResult>;
  logger: Meta["logger"];
};

type ResultOutcome =
  | {
      kind: "ok";
      result: ResultResponse;
    }
  | { kind: "fallback"; result: PDFProcessorResult };

async function fetchResult(deps: ResultDeps): Promise<ResultOutcome> {
  const { baseUrl, scrapeId, authHeader, meta, fetchImpl, sleep, fallback, logger } =
    deps;
  let retried409 = 0;

  while (true) {
    let resp;
    try {
      resp = await fetchImpl(`${baseUrl}/jobs/${scrapeId}/result`, {
        method: "GET",
        headers: { ...authHeader },
        signal: meta.abort.asSignal(),
      });
    } catch (error) {
      if (error instanceof AbortManagerThrownError) throw error;
      return {
        kind: "fallback",
        result: await fallback("network_error", { error: String(error) }),
      };
    }

    const status = resp.status;
    const body = await resp.json().catch(() => ({}));

    if (status === 503) {
      return {
        kind: "fallback",
        result: await fallback("result_503", { body }),
      };
    }

    if (status === 409) {
      retried409++;
      if (retried409 > 1) {
        return {
          kind: "fallback",
          result: await fallback("http_5xx", {
            status: 409,
            body,
            note: "result endpoint kept returning 409",
          }),
        };
      }
      logger.info("FirePDF async result returned 409, re-polling once", {
        scrapeId,
      });
      await sleep(POLL_FLOOR_MS, meta.abort.asSignal());
      continue;
    }

    if (status !== 200) {
      return {
        kind: "fallback",
        result: await fallback("http_5xx", { status, body }),
      };
    }

    const parsed = resultResponseSchema.safeParse(body);
    if (!parsed.success) {
      return {
        kind: "fallback",
        result: await fallback("http_5xx", {
          error: String(parsed.error),
          body,
        }),
      };
    }
    return { kind: "ok", result: parsed.data };
  }
}
