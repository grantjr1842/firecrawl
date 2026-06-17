import type { Document } from "../../../controllers/v2/types";
import type { CachedScrapeResult } from "../../../services/result-cache";

/**
 * PERF-2026-06-17-6 + BB-11: Convert a cached scrape payload back into a
 * `Document` suitable for serving from cache.
 *
 * Both the scrapeURL cache short-circuit (index.ts:1177) and the v1
 * batch-scrape precheck need to materialise the same shape. Extracting
 * the conversion into a shared helper keeps `metadata.cacheState = "hit"`
 * stamping and `cachedAt` carry-through consistent across both paths.
 *
 * The cached payload is the post-transformer Document with the cache
 * module's bookkeeping fields (`cachedAt`, `ttlSeconds`, `etag`)
 * stripped. We always overwrite `metadata.cacheState` to "hit" so it
 * stays accurate even if a future code path mutates the cache between
 * read and write.
 */
export function buildDocumentFromCachePayload(
  cached: CachedScrapeResult,
): Document {
  // Strip cache bookkeeping before handing the payload back as a Document.
  const {
    cachedAt: _cachedAt,
    ttlSeconds: _ttlSeconds,
    etag: _etag,
    ...rest
  } = cached;

  const cachedMetadata = (rest.metadata ?? {}) as Document["metadata"];
  const document: Document = {
    ...(rest as Omit<Document, "metadata">),
    metadata: {
      ...cachedMetadata,
      cacheState: "hit",
      cachedAt:
        typeof cached.cachedAt === "string"
          ? cached.cachedAt
          : new Date().toISOString(),
    } as Document["metadata"],
  };

  return document;
}
