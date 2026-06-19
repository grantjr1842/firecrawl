import { Response } from "express";
import { config } from "../../config";
import { v7 as uuidv7 } from "uuid";
import {
  CrawlRequest,
  crawlRequestSchema,
  CrawlResponse,
  RequestWithAuth,
  toV0CrawlerOptions,
} from "./types";
import {
  crawlToCrawler,
  saveCrawl,
  StoredCrawl,
  markCrawlActive,
} from "../../lib/crawl-redis";
import { _addScrapeJobToBullMQ } from "../../services/scrape-queue";
import { logger as _logger, devTrace } from "../../lib/logger";
import { generateCrawlerOptionsFromPrompt } from "../../scraper/scrapeURL/transformers/llmExtract";
import { CostTracking } from "../../lib/cost-tracking";
import { checkPermissions } from "../../lib/permissions";
import { buildPromptWithWebsiteStructure } from "../../lib/map-utils";
import {
  crawlGroup,
  resolveNewGroupBackend,
} from "../../services/worker/nuq-router";
import { logRequest } from "../../services/logging/log_job";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import {
  acquireApiEdgeSlot,
  releaseApiEdgeSlot,
} from "../../services/api-edge-concurrency";
import { isSelfHosted } from "../../lib/deployment";

export async function crawlController(
  req: RequestWithAuth<{}, CrawlResponse, CrawlRequest>,
  res: Response<CrawlResponse>,
) {
  const preNormalizedBody = req.body;
  req.body = crawlRequestSchema.parse(req.body);

  const permissions = checkPermissions(
    { ...req.body, crawlerOptions: req.body },
    req.acuc?.flags,
  );
  if (permissions.error) {
    return res.status(403).json({
      success: false,
      error: permissions.error,
    });
  }

  // QR-001(b): API-edge load-shedding. Crawl caps are intentionally
  // tighter than scrape caps because each crawl spins up a multi-page
  // group job that consumes worker slots for the lifetime of the
  // crawl. Self-hosted installs bypass the limiter.
  const crawlJobId = uuidv7();
  let edgeSlotHeld = false;
  if (!isSelfHosted() && config.CRAWL_API_CONCURRENCY_PER_TEAM > 0) {
    const leaseTtlMs =
      (req.body.crawlerOptions?.limit ?? 100) * 60_000 + 5 * 60_000; // cap-aware upper bound + grace
    const acquireResult = await acquireApiEdgeSlot(
      "crawl",
      req.auth.team_id,
      crawlJobId,
      config.CRAWL_API_CONCURRENCY_PER_TEAM,
      Math.min(leaseTtlMs, 6 * 60 * 60 * 1000), // hard ceiling at 6h
    );
    if (!acquireResult.granted) {
      const now = Date.now();
      const retryAfterSec = Math.max(
        1,
        Math.ceil((acquireResult.nextExpiryMs - now) / 1000),
      );
      devTrace("crawl.complete", {
        crawlId: crawlJobId,
        teamId: req.auth.team_id,
        success: false,
        errorCode: "API_EDGE_CONCURRENCY_LIMITED",
        statusCode: 429,
        inFlight: acquireResult.count,
      });
      return res.status(429).set("Retry-After", String(retryAfterSec)).json({
        success: false,
        error: "Team is at crawl concurrency limit. Try again later.",
        code: "API_EDGE_CONCURRENCY_LIMITED",
        retryAfterSeconds: retryAfterSec,
      });
    }
    edgeSlotHeld = true;
  }

  try {
    return await runCrawlController(
      req,
      res,
      preNormalizedBody,
      crawlJobId,
      edgeSlotHeld,
    );
  } finally {
    if (edgeSlotHeld) {
      releaseApiEdgeSlot("crawl", req.auth.team_id, crawlJobId).catch(() => {});
    }
  }
}

async function runCrawlController(
  req: RequestWithAuth<{}, CrawlResponse, CrawlRequest>,
  res: Response<CrawlResponse>,
  preNormalizedBody: any,
  crawlJobId: string,
  _edgeSlotHeld: boolean,
) {
  const zeroDataRetention =
    getScrapeZDR(req.acuc?.flags) === "forced" || req.body.zeroDataRetention;

  const id = uuidv7();
  const logger = _logger.child({
    crawlId: id,
    module: "api/v2",
    method: "crawlController",
    teamId: req.auth.team_id,
    zeroDataRetention,
  });

  devTrace("crawl.queue.received", {
    crawlId: id,
    teamId: req.auth.team_id,
    url: req.body.url,
    apiKeyId: req.acuc?.api_key_id,
    zeroDataRetention,
  });

  logger.debug("Crawl " + id + " starting", {
    request: req.body,
    originalRequest: preNormalizedBody,
    account: req.account,
  });

  await logRequest({
    id,
    kind: "crawl",
    api_version: "v2",
    team_id: req.auth.team_id,
    origin: req.body.origin ?? "api",
    integration: req.body.integration,
    target_hint: req.body.url,
    zeroDataRetention: zeroDataRetention || false,
    api_key_id: req.acuc?.api_key_id ?? null,
  });

  let { remainingCredits } = req.account!;
  const useDbAuthentication = config.USE_DB_AUTHENTICATION;
  if (!useDbAuthentication) {
    remainingCredits = Infinity;
  }

  const crawlerOptions = {
    ...req.body,
    url: undefined,
    scrapeOptions: undefined,
    prompt: undefined,
  };
  const scrapeOptions = req.body.scrapeOptions;

  let promptGeneratedOptions = {};
  if (req.body.prompt) {
    try {
      // Enhance prompt with discovered site URLs (up to 120) to improve option generation
      const { prompt: enhancedPrompt } = await buildPromptWithWebsiteStructure({
        basePrompt: req.body.prompt,
        url: req.body.url,
        teamId: req.auth.team_id,
        flags: req.acuc?.flags ?? null,
        logger,
        limit: 50,
        includeSubdomains: false,
        allowExternalLinks: false,
        useIndex: true,
        maxFireEngineResults: 500,
      });
      const costTracking = new CostTracking();
      const { extract } = await generateCrawlerOptionsFromPrompt(
        enhancedPrompt,
        logger,
        costTracking,
        { teamId: req.auth.team_id, crawlId: id },
      );
      promptGeneratedOptions = extract || {};
      logger.debug("Generated crawler options from prompt", {
        prompt: req.body.prompt,
        generatedOptions: promptGeneratedOptions,
      });
      logger.debug(JSON.stringify(promptGeneratedOptions, null, 2));
    } catch (error) {
      logger.error("Failed to generate crawler options from prompt", {
        error: error.message,
        prompt: req.body.prompt,
      });
      return res.status(400).json({
        success: false,
        error:
          "Failed to process natural language prompt. Please try rephrasing or use explicit crawler options.",
      });
    }
  }

  // Merge behavior:
  // - Start with parsed crawlerOptions (which contains schema defaults)
  // - Overlay promptGeneratedOptions ONLY for fields the user did not explicitly provide
  //   in the original request (preNormalizedBody) or provided as null/undefined.
  // This prevents empty defaults like [] from overwriting meaningful prompt-generated values.
  const finalCrawlerOptions: any = { ...crawlerOptions };
  for (const [key, value] of Object.entries(promptGeneratedOptions)) {
    const userProvided = Object.prototype.hasOwnProperty.call(
      preNormalizedBody,
      key,
    );
    if (
      !userProvided ||
      preNormalizedBody[key] === undefined ||
      preNormalizedBody[key] === null
    ) {
      finalCrawlerOptions[key] = value;
    }
  }

  if (Array.isArray(finalCrawlerOptions.includePaths)) {
    for (const x of finalCrawlerOptions.includePaths) {
      try {
        new RegExp(x);
      } catch (e) {
        return res.status(400).json({ success: false, error: e.message });
      }
    }
  }

  if (Array.isArray(finalCrawlerOptions.excludePaths)) {
    for (const x of finalCrawlerOptions.excludePaths) {
      try {
        new RegExp(x);
      } catch (e) {
        return res.status(400).json({ success: false, error: e.message });
      }
    }
  }

  const originalLimit = finalCrawlerOptions.limit;
  finalCrawlerOptions.limit = Math.min(
    remainingCredits,
    finalCrawlerOptions.limit,
  );
  logger.debug("Determined limit: " + finalCrawlerOptions.limit, {
    remainingCredits,
    bodyLimit: originalLimit,
    originalBodyLimit: preNormalizedBody.limit,
  });

  const sc: StoredCrawl = {
    originUrl: req.body.url,
    crawlerOptions: toV0CrawlerOptions(finalCrawlerOptions),
    scrapeOptions,
    internalOptions: {
      disableSmartWaitCache: true,
      teamId: req.auth.team_id,
      saveScrapeResultToGCS: config.GCS_FIRE_ENGINE_BUCKET_NAME ? true : false,
      zeroDataRetention,
      agentIndexOnly: (req as any).agentIndexOnly ?? false,
    },
    team_id: req.auth.team_id,
    createdAt: Date.now(),
    maxConcurrency:
      req.body.maxConcurrency !== undefined
        ? req.acuc?.concurrency !== undefined
          ? Math.min(req.body.maxConcurrency, req.acuc.concurrency)
          : req.body.maxConcurrency
        : undefined,
    zeroDataRetention,
    v1: true,
    webhook: req.body.webhook,
  };

  const crawler = crawlToCrawler(id, sc, req.acuc?.flags ?? null);

  try {
    sc.robots = await crawler.getRobotsTxt(scrapeOptions.skipTlsVerification);
    // const robotsCrawlDelay = crawler.getRobotsCrawlDelay();
    // if (robotsCrawlDelay !== null && !sc.crawlerOptions.delay) {
    //   sc.crawlerOptions.delay = robotsCrawlDelay;
    // }
  } catch (e) {
    logger.debug("Failed to get robots.txt (this is probably fine!)", {
      error: e,
    });
  }

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

  await _addScrapeJobToBullMQ(
    {
      url: req.body.url,
      mode: "kickoff" as const,
      team_id: req.auth.team_id,
      crawlerOptions: finalCrawlerOptions,
      scrapeOptions: sc.scrapeOptions,
      internalOptions: sc.internalOptions,
      origin: req.body.origin,
      integration: req.body.integration,
      billing: { endpoint: "crawl", jobId: id },
      crawl_id: id,
      webhook: req.body.webhook,
      v1: true,
      zeroDataRetention: zeroDataRetention || false,
      apiKeyId: req.acuc?.api_key_id ?? null,
    },
    uuidv7(),
  );

  const protocol = req.protocol;

  devTrace("crawl.complete", {
    crawlId: id,
    teamId: req.auth.team_id,
    success: true,
  });

  return res.status(200).json({
    success: true,
    id,
    url: `${protocol}://${req.get("host")}/v2/crawl/${id}`,
    ...(req.body.prompt && {
      promptGeneratedOptions: promptGeneratedOptions,
      finalCrawlerOptions: finalCrawlerOptions,
    }),
  });
}
