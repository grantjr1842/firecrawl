import type { Span } from "@sentry/node";
import { setSpanAttributes } from "../../lib/otel-tracer";
import type { Document } from "../../controllers/v2/types";
import { EngineScrapeResult, Engine, FeatureFlag } from "./engines";
import { postprocessors } from "./postprocessors";
import { executeTransformers } from "./transformers";
import { Meta, ScrapeUrlResponse } from "./preflight";

export type EngineScrapeResultWithContext = {
  engine: Engine;
  unsupportedFeatures: Set<FeatureFlag>;
  result: EngineScrapeResult;
};

export async function applyTransformStep(
  meta: Meta,
  result: EngineScrapeResultWithContext,
  fallbackList: { engine: Engine; unsupportedFeatures: Set<FeatureFlag> }[],
  span: Span,
): Promise<ScrapeUrlResponse> {
  let engineResult: EngineScrapeResult = result.result;

  for (const postprocessor of postprocessors) {
    if (
      postprocessor.shouldRun(
        meta,
        new URL(engineResult.url),
        engineResult.postprocessorsUsed,
      )
    ) {
      meta.logger.info("Running postprocessor " + postprocessor.name);
      try {
        engineResult = await postprocessor.run(
          {
            ...meta,
            logger: meta.logger.child({
              method: "postprocessors/" + postprocessor.name,
            }),
          },
          engineResult,
        );
      } catch (error) {
        meta.logger.warn("Failed to run postprocessor " + postprocessor.name, {
          error,
        });
      }
    }
  }

  let document: Document = {
    markdown: engineResult.markdown,
    rawHtml: engineResult.html,
    screenshot: engineResult.screenshot,
    actions: engineResult.actions,
    branding: engineResult.branding,
    metadata: {
      sourceURL: meta.internalOptions.unnormalizedSourceURL ?? meta.url,
      url: engineResult.url,
      statusCode: engineResult.statusCode,
      error: engineResult.error,
      numPages: engineResult.pdfMetadata?.numPages,
      ...(engineResult.pdfMetadata?.title
        ? { title: engineResult.pdfMetadata.title }
        : {}),
      contentType: engineResult.contentType,
      timezone: engineResult.timezone,
      proxyUsed: engineResult.proxyUsed ?? "basic",
      ...(fallbackList.find(x =>
        ["index", "index;documents"].includes(x.engine),
      )
        ? engineResult.cacheInfo
          ? {
              cacheState: "hit",
              cachedAt: engineResult.cacheInfo.created_at.toISOString(),
            }
          : { cacheState: "miss" }
        : {}),
      postprocessorsUsed: engineResult.postprocessorsUsed,
    },
  };

  if (result.unsupportedFeatures.size > 0) {
    const warning = `The engine used does not support the following features: ${[...result.unsupportedFeatures].join(", ")} -- your scrape may be partial.`;
    meta.logger.warn(warning, {
      engine: result.engine,
      unsupportedFeatures: result.unsupportedFeatures,
    });
    document.warning =
      document.warning !== undefined
        ? document.warning + " " + warning
        : warning;
  }

  document = await executeTransformers(meta, document);

  setSpanAttributes(span, {
    "engine.final_status_code": document.metadata.statusCode,
    "engine.final_url": document.metadata.url,
    "engine.content_type": document.metadata.contentType,
    "engine.proxy_used": document.metadata.proxyUsed,
    "engine.cache_state": document.metadata.cacheState,
    "engine.postprocessors_used": engineResult.postprocessorsUsed?.join(","),
  });

  return {
    success: true,
    document,
    unsupportedFeatures: result.unsupportedFeatures,
  };
}
