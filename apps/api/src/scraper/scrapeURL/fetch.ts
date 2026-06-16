import { config } from "../../config";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";
import { scrapeOptions } from "../../controllers/v2/types";
import { parseMarkdown } from "../../lib/html-to-markdown";
import { hasFormatOfType } from "../../lib/format-utils";
import { htmlTransform } from "./lib/removeUnwantedElements";
import { ActionsNotSupportedError, ScrapeJobTimeoutError } from "../../lib/error";
import { LLMRefusalError } from "./transformers/llmExtract";
import {
  AbortInstance,
  AbortManagerThrownError,
} from "./lib/abortManager";
import {
  buildFallbackList,
  Engine,
  EngineScrapeResult,
  FeatureFlag,
  getEngineMaxReasonableTime,
  scrapeURLWithEngine,
} from "./engines";
import {
  ActionError,
  AddFeatureError,
  AgentIndexOnlyError,
  DNSResolutionError,
  DocumentAntibotError,
  EngineError,
  EngineSnipedError,
  EngineUnsuccessfulError,
  FEPageLoadFailed,
  IndexMissError,
  LockdownMissError,
  NoCachedDataError,
  NoEnginesLeftError,
  PDFAntibotError,
  PDFInsufficientTimeError,
  PDFOCRRequiredError,
  ProxySelectionError,
  RemoveFeatureError,
  SSLError,
  SiteError,
  UnsupportedFileError,
  WaterfallNextEngineSignal,
  XTwitterConfigurationError,
  ZDRViolationError,
} from "./error";
import {
  applyTransformStep,
  EngineScrapeResultWithContext,
} from "./transform";
import { Meta, ScrapeUrlResponse, BrowserCookie } from "./preflight";

const MAX_HTML_SIZE_FOR_MARKDOWN_CHECK = 300 * 1024;

async function scrapeURLLoopIter(
  meta: Meta,
  engine: Engine,
  snipeAbort,
): Promise<EngineScrapeResult> {
  const abort = meta.abort.child(snipeAbort);
  try {
    const engineResult = await scrapeURLWithEngine(
      { ...meta, abort },
      engine,
    );

    const hasMarkdown = hasFormatOfType(meta.options.formats, "markdown");
    const hasChangeTracking = hasFormatOfType(
      meta.options.formats,
      "changeTracking",
    );
    const hasJson = hasFormatOfType(meta.options.formats, "json");
    const hasSummary = hasFormatOfType(meta.options.formats, "summary");
    const hasQuestion = hasFormatOfType(meta.options.formats, "question");
    const hasHighlights = hasFormatOfType(meta.options.formats, "highlights");
    const hasQuery = hasFormatOfType(meta.options.formats, "query");
    const needsMarkdown =
      hasMarkdown ||
      hasChangeTracking ||
      hasJson ||
      hasSummary ||
      hasQuestion ||
      hasHighlights ||
      hasQuery;

    let checkMarkdown: string;
    const htmlSize = engineResult.html?.length ?? 0;
    const shouldSkipMarkdownCheck = htmlSize > MAX_HTML_SIZE_FOR_MARKDOWN_CHECK;

    if (
      meta.internalOptions.teamId === "sitemap" ||
      meta.internalOptions.teamId === "robots-txt"
    ) {
      checkMarkdown = engineResult.html?.trim() ?? "";
    } else if (!needsMarkdown) {
      checkMarkdown = engineResult.html?.trim() ?? "";
    } else if (shouldSkipMarkdownCheck) {
      meta.logger.debug(
        "Skipping markdown conversion for quality check due to large HTML size",
        { htmlSize, threshold: MAX_HTML_SIZE_FOR_MARKDOWN_CHECK },
      );
      checkMarkdown = engineResult.html?.trim() ?? "";
    } else {
      const requestId = meta.id || meta.internalOptions.crawlId;
      const zeroDataRetention = meta.internalOptions.zeroDataRetention;
      checkMarkdown = await parseMarkdown(
        await htmlTransform(
          engineResult.html,
          meta.url,
          scrapeOptions.parse({ onlyMainContent: true }),
        ),
        { logger: meta.logger, requestId, zeroDataRetention },
      );
      if (checkMarkdown.trim().length === 0) {
        checkMarkdown = await parseMarkdown(
          await htmlTransform(
            engineResult.html,
            meta.url,
            scrapeOptions.parse({ onlyMainContent: false }),
          ),
          { logger: meta.logger, requestId, zeroDataRetention },
        );
      }
    }

    const isLongEnough = checkMarkdown.trim().length > 0;
    const isGoodStatusCode =
      (engineResult.statusCode >= 200 && engineResult.statusCode < 300) ||
      engineResult.statusCode === 304;
    const hasNoPageError = engineResult.error === undefined;
    const isLikelyProxyError = [401, 403, 429].includes(
      engineResult.statusCode,
    );

    if (
      isLikelyProxyError &&
      meta.options.proxy === "auto" &&
      !meta.featureFlags.has("stealthProxy")
    ) {
      meta.logger.info(
        "Scrape via " +
          engine +
          " deemed unsuccessful due to proxy inadequacy. Adding stealthProxy flag.",
        {
          factors: { isLongEnough, isGoodStatusCode, hasNoPageError },
          statusCode: engineResult.statusCode,
          length: engineResult.html?.trim().length ?? 0,
        },
      );
      throw new AddFeatureError(["stealthProxy"]);
    }

    if (isLongEnough || !isGoodStatusCode) {
      meta.logger.info("Scrape via " + engine + " deemed successful.", {
        factors: { isLongEnough, isGoodStatusCode, hasNoPageError },
      });
      return engineResult;
    } else {
      meta.logger.warn("Scrape via " + engine + " deemed unsuccessful.", {
        factors: { isLongEnough, isGoodStatusCode, hasNoPageError },
        length: engineResult.html?.trim().length ?? 0,
      });
      throw new EngineUnsuccessfulError(engine);
    }
  } finally {
    abort?.dispose();
  }
}

class WrappedEngineError extends Error {
  name = "WrappedEngineError";
  public engine: Engine;
  public error: any;
  constructor(engine: Engine, error: any) {
    super("WrappedEngineError");
    this.engine = engine;
    this.error = error;
  }
}

export async function scrapeURLLoop(meta: Meta): Promise<ScrapeUrlResponse> {
  return withSpan("scrape.engine_loop", async span => {
    meta.logger.info(
      `Scraping URL ${JSON.stringify(meta.rewrittenUrl ?? meta.url)}...`,
    );
    setSpanAttributes(span, {
      "engine.url": meta.rewrittenUrl ?? meta.url,
      "engine.features": Array.from(meta.featureFlags).join(","),
    });

    if (meta.internalOptions.zeroDataRetention) {
      if (meta.featureFlags.has("screenshot"))
        throw new ZDRViolationError("screenshot");
      if (meta.featureFlags.has("screenshot@fullScreen"))
        throw new ZDRViolationError("screenshot@fullScreen");
      if (
        meta.options.actions &&
        meta.options.actions.find(x => x.type === "screenshot")
      )
        throw new ZDRViolationError("screenshot action");
      if (
        meta.options.actions &&
        meta.options.actions.find(x => x.type === "pdf")
      )
        throw new ZDRViolationError("pdf action");
    }

    const fallbackList = await buildFallbackList(meta);

    if (meta.featureFlags.has("actions")) {
      if (
        fallbackList.length === 0 ||
        fallbackList.every(engine => engine.unsupportedFeatures.has("actions"))
      ) {
        throw new ActionsNotSupportedError(
          "Actions are not supported by any available engines. Actions require Fire Engine (fire-engine) to be enabled.",
        );
      }
    }

    setSpanAttributes(span, {
      "engine.fallback_list": fallbackList.map(f => f.engine).join(","),
    });

    const snipeAbortController = new AbortController();
    const snipeAbort: AbortInstance = {
      signal: snipeAbortController.signal,
      tier: "engine",
      throwable() {
        return new EngineSnipedError();
      },
    };

    type EngineBundlePromise = {
      engine: Engine;
      unsupportedFeatures: Set<FeatureFlag>;
      promise: Promise<EngineScrapeResultWithContext>;
    };

    const remainingEngines = [...fallbackList];
    let enginePromises: EngineBundlePromise[] = [];
    const enginesAttempted: string[] = [];
    meta.abort.throwIfAborted();
    let result: EngineScrapeResultWithContext | null = null;

    while (remainingEngines.length > 0) {
      const { engine, unsupportedFeatures } = remainingEngines.shift()!;
      enginesAttempted.push(engine);
      const waitUntilWaterfall =
        getEngineMaxReasonableTime(meta, engine) +
        config.SCRAPEURL_ENGINE_WATERFALL_DELAY_MS;

      if (
        !isFinite(waitUntilWaterfall) ||
        isNaN(waitUntilWaterfall) ||
        waitUntilWaterfall <= 0
      ) {
        meta.logger.warn("Invalid waitUntilWaterfall value", {
          waitUntilWaterfall,
          timeout: meta.options.timeout,
          actions: !!meta.options.actions,
          hasJson: !!meta.options.formats?.find(x => x.type === "json"),
          remainingEngines: remainingEngines.length,
        });
      }

      meta.logger.info("Scraping via " + engine + "...", { waitUntilWaterfall });

      enginePromises.push({
        engine,
        unsupportedFeatures,
        promise: (async () => {
          try {
            return {
              engine,
              unsupportedFeatures,
              result: await scrapeURLLoopIter(meta, engine, snipeAbort),
            };
          } catch (error) {
            throw new WrappedEngineError(engine, error);
          }
        })(),
      });

      while (true) {
        let timeouts: NodeJS.Timeout[] = [];
        try {
          result = await Promise.race([
            ...enginePromises.map(x => x.promise),
            ...(remainingEngines.length > 0
              ? [
                  new Promise<EngineScrapeResultWithContext>((_, reject) => {
                    timeouts.push(
                      setTimeout(() => {
                        reject(new WaterfallNextEngineSignal());
                      }, waitUntilWaterfall),
                    );
                  }),
                ]
              : []),
            new Promise<EngineScrapeResultWithContext>((_, reject) => {
              timeouts.push(
                setTimeout(() => {
                  try {
                    meta.abort.throwIfAborted();
                    const usingDefaultTimeout =
                      meta.abort.scrapeTimeout() === undefined;
                    throw new ScrapeJobTimeoutError(
                      usingDefaultTimeout
                        ? "Scrape timed out due to maximum length of 5 minutes"
                        : "Scrape timed out",
                    );
                  } catch (error) {
                    reject(error);
                  }
                }, meta.abort.scrapeTimeout() ?? 300000),
              );
            }),
          ]);
          break;
        } catch (error) {
          if (error instanceof WrappedEngineError) {
            if (error.engine === "x-twitter") {
              meta.logger.warn("X/Twitter scrape failed fatally.", {
                error: error.error,
              });
              throw error.error;
            } else if (error.error instanceof EngineError) {
              meta.logger.warn(
                "Engine " + error.engine + " could not scrape the page.",
                { error: error.error },
              );
            } else if (error.error instanceof IndexMissError) {
              meta.logger.warn(
                "Engine " + error.engine + " could not find the page in the index.",
                { error: error.error },
              );
            } else if (
              error.error instanceof AddFeatureError ||
              error.error instanceof RemoveFeatureError ||
              error.error instanceof SiteError ||
              error.error instanceof SSLError ||
              error.error instanceof DNSResolutionError ||
              error.error instanceof ActionError ||
              error.error instanceof UnsupportedFileError ||
              error.error instanceof PDFAntibotError ||
              error.error instanceof PDFOCRRequiredError ||
              error.error instanceof DocumentAntibotError ||
              error.error instanceof PDFInsufficientTimeError ||
              error.error instanceof ProxySelectionError ||
              error.error instanceof NoCachedDataError ||
              error.error instanceof AgentIndexOnlyError ||
              error.error instanceof XTwitterConfigurationError
            ) {
              throw error.error;
            } else if (error.error instanceof LLMRefusalError) {
              meta.logger.warn("LLM refusal encountered", { error: error.error });
              throw error.error;
            } else if (error.error instanceof FEPageLoadFailed) {
              meta.logger.warn("FEPageLoadFailed encountered", { error: error.error });
            } else if (error.error instanceof AbortManagerThrownError) {
              if (error.error.tier === "engine") {
                meta.logger.warn(
                  "Engine " + error.engine + " timed out while scraping.",
                  { error: error.error },
                );
              } else {
                throw error.error;
              }
            } else {
              meta.logger.warn(
                "An unexpected error happened while scraping with " + error.engine + ".",
                { error },
              );
            }

            enginePromises = enginePromises.filter(x => x.engine !== error.engine);
            if (enginePromises.length === 0) break;
          } else if (
            error instanceof AddFeatureError ||
            error instanceof RemoveFeatureError
          ) {
            throw error;
          } else if (error instanceof WaterfallNextEngineSignal) {
            break;
          } else if (error instanceof ScrapeJobTimeoutError) {
            throw error;
          } else if (error instanceof AbortManagerThrownError) {
            if (error.tier === "engine") {
              meta.logger.warn("Engine-scoped timeout error received here. Weird!", { error });
            }
            throw error;
          } else {
            meta.logger.warn("Unexpected error while racing engines", { error });
            throw error;
          }
        } finally {
          for (const to of timeouts) clearTimeout(to);
        }
      }

      if (result === null) {
        meta.logger.info("Waterfalling to next engine...", { waitUntilWaterfall });
      } else {
        break;
      }
    }

    snipeAbortController.abort();

    if (result === null) {
      setSpanAttributes(span, {
        "engine.no_engines_left": true,
        "engine.engines_attempted": enginesAttempted.join(","),
      });
      if (meta.options.lockdown) throw new LockdownMissError();
      throw new NoEnginesLeftError(fallbackList.map(x => x.engine));
    }

    setSpanAttributes(span, {
      "engine.winner": result.engine,
      "engine.engines_attempted": enginesAttempted.join(","),
      "engine.unsupported_features":
        result.unsupportedFeatures.size > 0
          ? Array.from(result.unsupportedFeatures).join(",")
          : undefined,
    });

    meta.winnerEngine = result.engine;
    meta.audioCookies = (result.result as { audioCookies?: BrowserCookie[] }).audioCookies;

    return applyTransformStep(meta, result, fallbackList, span);
  });
}
