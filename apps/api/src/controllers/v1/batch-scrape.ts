import { Response } from "express";
import { config } from "../../config";
import { v7 as uuidv7 } from "uuid";
import {
  BatchScrapeRequest,
  batchScrapeRequestSchema,
  batchScrapeRequestSchemaNoURLValidation,
  url as urlSchema,
  RequestWithAuth,
  BatchScrapeResponse,
} from "./types";
import {
  addCrawlJobs,
  finishCrawlKickoff,
  getCrawl,
  lockURLs,
  markCrawlActive,
  saveCrawl,
  StoredCrawl,
} from "../../lib/crawl-redis";
import { getJobPriority } from "../../lib/job-priority";
import { addScrapeJobs } from "../../services/scrape-queue";
import { createWebhookSender, WebhookEvent } from "../../services/webhook";
import { logger as _logger, devTrace } from "../../lib/logger";
import { UNSUPPORTED_SITE_MESSAGE } from "../../lib/strings";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
import { fromV1ScrapeOptions } from "../v2/types";
import { checkPermissions } from "../../lib/permissions";
import {
  crawlGroup,
  resolveNewGroupBackend,
} from "../../services/worker/nuq-router";
import { logRequest } from "../../services/logging/log_job";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import {
  getCachedResultTiered,
  pickCacheTier,
} from "../../services/result-cache";
import { rewriteUrl } from "../../scraper/scrapeURL/lib/rewriteUrl";
import { buildDocumentFromCachePayload } from "../../scraper/scrapeURL/lib/cacheDocument";
import { mergeBatchResult } from "../../services/worker/crawl-logic";

export async function batchScrapeController(
  req: RequestWithAuth<{}, BatchScrapeResponse, BatchScrapeRequest>,
  res: Response<BatchScrapeResponse>,
) {
  const preNormalizedBody = { ...req.body };
  if (req.body?.ignoreInvalidURLs === true) {
    req.body = batchScrapeRequestSchemaNoURLValidation.parse(req.body);
  } else {
    req.body = batchScrapeRequestSchema.parse(req.body);
  }

  const permissions = checkPermissions(req.body, req.acuc?.flags);
  if (permissions.error) {
    // OBS-DEVTRACE-V1-GAP: terminal permission-denied path.
    devTrace("scrape.complete", {
      teamId: req.auth.team_id,
      version: "v1",
      controller: "batchScrape",
      success: false,
      errorCode: "PERMISSION_DENIED",
    });
    return res.status(403).json({
      success: false,
      error: permissions.error,
    });
  }

  const zeroDataRetention =
    getScrapeZDR(req.acuc?.flags) === "forced" || req.body.zeroDataRetention;

  const id = req.body.appendToId ?? uuidv7();
  // OBS-DEVTRACE-V1-GAP: batch-scrape lifecycle received event.
  devTrace("scrape.received", {
    crawlId: id,
    teamId: req.auth.team_id,
    version: "v1",
    controller: "batchScrape",
    urlCount: req.body.urls?.length ?? 0,
  });
  const logger = _logger.child({
    crawlId: id,
    batchScrapeId: id,
    module: "api/v1",
    method: "batchScrapeController",
    teamId: req.auth.team_id,
    zeroDataRetention,
  });

  let urls: string[] = req.body.urls;
  let unnormalizedURLs = preNormalizedBody.urls;
  let invalidURLs: string[] | undefined = undefined;

  if (req.body.ignoreInvalidURLs) {
    invalidURLs = [];

    let pendingURLs = urls;
    urls = [];
    unnormalizedURLs = [];
    for (const u of pendingURLs) {
      try {
        const nu = urlSchema.parse(u);
        if (
          !isUrlBlocked(nu, req.acuc?.flags ?? null, {
            team_id: req.auth.team_id,
            origin: req.body.origin ?? null,
          })
        ) {
          urls.push(nu);
          unnormalizedURLs.push(u);
        } else {
          invalidURLs.push(u);
        }
      } catch (_) {
        invalidURLs.push(u);
      }
    }
  } else {
    if (
      req.body.urls?.some((url: string) =>
        isUrlBlocked(url, req.acuc?.flags ?? null, {
          team_id: req.auth.team_id,
          origin: req.body.origin ?? null,
        }),
      )
    ) {
      if (!res.headersSent) {
        return res.status(403).json({
          success: false,
          error: UNSUPPORTED_SITE_MESSAGE,
        });
      }
    }
  }

  if (urls.length === 0) {
    return res.status(400).json({
      success: false,
      error: "No valid URLs provided",
    });
  }

  logger.debug("Batch scrape " + id + " starting", {
    urlsLength: urls.length,
    appendToId: req.body.appendToId,
    account: req.account,
  });

  if (!req.body.appendToId) {
    await logRequest({
      id,
      kind: "batch_scrape",
      api_version: "v1",
      team_id: req.auth.team_id,
      origin: req.body.origin ?? "api",
      integration: req.body.integration,
      target_hint: urls[0] ?? "",
      zeroDataRetention: zeroDataRetention || false,
      api_key_id: req.acuc?.api_key_id ?? null,
    });
  }

  const { scrapeOptions, internalOptions } = fromV1ScrapeOptions(
    req.body,
    req.body.timeout,
    req.auth.team_id,
  );

  const sc: StoredCrawl = req.body.appendToId
    ? ((await getCrawl(req.body.appendToId)) as StoredCrawl)
    : {
        crawlerOptions: null,
        scrapeOptions,
        internalOptions: {
          ...internalOptions,
          disableSmartWaitCache: true,
          teamId: req.auth.team_id,
          saveScrapeResultToGCS: config.GCS_FIRE_ENGINE_BUCKET_NAME
            ? true
            : false,
          zeroDataRetention,
          agentIndexOnly: (req as any).agentIndexOnly ?? false,
        }, // NOTE: smart wait disabled for batch scrapes to ensure contentful scrape, speed does not matter
        team_id: req.auth.team_id,
        createdAt: Date.now(),
        maxConcurrency: req.body.maxConcurrency,
        zeroDataRetention,
        v1: true,
        webhook: req.body.webhook,
      };

  if (!req.body.appendToId) {
    sc.queueBackend = await resolveNewGroupBackend(sc.team_id);
    await crawlGroup.addGroup(
      id,
      sc.team_id,
      (req.acuc?.flags?.crawlTtlHours ?? 24) * 60 * 60 * 1000,
      {
        backend: sc.queueBackend,
        maxConcurrency: sc.maxConcurrency,
        delaySeconds: sc.crawlerOptions?.delay,
      },
    );
    await saveCrawl(id, sc);
    await markCrawlActive(id);
  }

  let jobPriority = 20;

  // If it is over 1000, we need to get the job priority,
  // otherwise we can use the default priority of 20
  if (urls.length > 1000) {
    // set base to 21
    jobPriority = await getJobPriority({
      team_id: req.auth.team_id,
      basePriority: 21,
    });
  }
  logger.debug("Using job priority " + jobPriority, { jobPriority });
  const billing = { endpoint: "batch_scrape" as const, jobId: id };

  // ---------------------------------------------------------------------
  // PERF-2026-06-17-6: batch cache precheck.
  //
  // For a 10K-url batch with an 80% cache-hit ratio (a common re-index
  // pattern), paying full NuQ round-trip + lock acquire + team-semaphore
  // for the 8K cache-warm URLs is wasteful: the scrapeURL cache
  // short-circuit (scrapeURL/index.ts:1165) would have served them in
  // <1ms anyway. We do an O(n) Redis lookup here and skip enqueuing for
  // hits. The hit documents are merged into the batch result store via
  // `mergeBatchResult`; the crawl-status endpoint stitches them back at
  // read time so the user sees a single unified stream.
  //
  // Gating rules:
  //   - RESULT_CACHE_PRECHECK_BATCH env (default true)
  //   - ZDR requests bypass entirely (cache module never reads/writes
  //     for zdr=true; the privacy contract is non-negotiable)
  //   - The v1 batch controller sets disableSmartWaitCache:true at
  //     sc.internalOptions so every batch URL actually runs; we keep
  //     that for the misses we still enqueue, since the cache-hit URLs
  //     never reach the worker.
  // ---------------------------------------------------------------------
  if (
    config.RESULT_CACHE_PRECHECK_BATCH &&
    !zeroDataRetention &&
    urls.length > 0
  ) {
    const tier = pickCacheTier(scrapeOptions.formats as any);
    logger.debug("Running batch cache precheck", {
      tier,
      urls: urls.length,
    });
    // Promise.all (not allSettled): a single cache lookup failure should
    // be visible. Redis is best-effort inside getCachedResultTiered (it
    // swallows errors and returns null), so a thrown error here means a
    // programming bug, not transient infrastructure.
    const cachedResults = await Promise.all(
      urls.map(async url => {
        const rewritten = rewriteUrl(url) ?? url;
        const cached = await getCachedResultTiered(
          rewritten,
          tier,
          false,
          req.auth.team_id,
        );
        return [url, cached] as const;
      }),
    );
    const hits = cachedResults.filter(
      (entry): entry is [string, NonNullable<typeof entry[1]>] =>
        entry[1] !== null,
    );
    const misses = cachedResults
      .filter(([, r]) => r === null)
      .map(([u]) => u);

    logger.debug("Batch cache precheck complete", {
      tier,
      hits: hits.length,
      misses: misses.length,
    });

    // Merge hit documents directly into the batch result store. The
    // helper is best-effort: any Redis failure is logged and swallowed,
    // and the URL falls through to the enqueue path.
    for (const [url, cached] of hits) {
      const document = buildDocumentFromCachePayload(cached);
      await mergeBatchResult(id, url, document);
    }

    // Only the misses need to flow through NuQ. Note: this preserves
    // ordering within the misses (filter is stable, map preserves
    // order), so the per-batch URL order observed by workers matches
    // the user's request order modulo the precheck hits.
    urls = misses;
  }

  const jobs = urls.map(x => ({
    jobId: uuidv7(),
    data: {
      url: x,
      mode: "single_urls" as const,
      team_id: req.auth.team_id,
      crawlerOptions: null,
      scrapeOptions,
      origin: "api",
      integration: req.body.integration,
      billing,
      crawl_id: id,
      sitemapped: true,
      v1: true,
      webhook: req.body.webhook,
      internalOptions: sc.internalOptions,
      zeroDataRetention: zeroDataRetention ?? false,
      apiKeyId: req.acuc?.api_key_id ?? null,
    },
    priority: jobPriority,
  }));

  await finishCrawlKickoff(id);

  logger.debug("Locking URLs...");
  await lockURLs(
    id,
    sc,
    jobs.map(x => x.data.url),
    logger,
  );
  logger.debug("Adding scrape jobs to Redis...");
  await addCrawlJobs(
    id,
    jobs.map(x => x.jobId),
    logger,
  );
  logger.debug("Adding scrape jobs to BullMQ...");
  await addScrapeJobs(jobs);

  if (req.body.webhook) {
    logger.debug("Calling webhook with batch_scrape.started...", {
      webhook: req.body.webhook,
    });
    const sender = await createWebhookSender({
      teamId: req.auth.team_id,
      jobId: id,
      webhook: req.body.webhook,
      v0: false,
    });
    await sender?.send(WebhookEvent.BATCH_SCRAPE_STARTED, { success: true });
  }

  const protocol = req.protocol;

  // OBS-DEVTRACE-V1-GAP: terminal success-path for batch-scrape.
  devTrace("scrape.complete", {
    crawlId: id,
    teamId: req.auth.team_id,
    version: "v1",
    controller: "batchScrape",
    success: true,
    invalidURLCount: invalidURLs?.length ?? 0,
  });

  return res.status(200).json({
    success: true,
    id,
    url: `${protocol}://${req.get("host")}/v1/batch/scrape/${id}`,
    invalidURLs,
  });
}
