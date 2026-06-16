import { Logger } from "winston";
import path from "node:path";
import { tmpdir } from "node:os";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import {
  type Document,
  type ScrapeOptions,
  type TeamFlags,
} from "../../controllers/v2/types";
import { ScrapeOptions as ScrapeOptionsV1 } from "../../controllers/v1/types";
import { logger as _logger } from "../../lib/logger";
import { hasFormatOfType } from "../../lib/format-utils";
import { CostTracking } from "../../lib/cost-tracking";
import { getEngineForUrl } from "../WebScraper/utils/engine-forcing";
import { loadMock, MockState } from "./lib/mock";
import { rewriteUrl } from "./lib/rewriteUrl";
import { urlSpecificParams } from "./lib/urlSpecificParams";
import { ScrapeJobTimeoutError } from "../../lib/error";
import { AbortInstance, AbortManager } from "./lib/abortManager";
import { Engine, FeatureFlag } from "./engines";
import { UnsupportedFileError } from "./error";

export type ScrapeUrlResponse =
  | {
      success: true;
      document: Document;
      unsupportedFeatures?: Set<FeatureFlag>;
    }
  | {
      success: false;
      error: any;
    };

export type BrowserCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  [key: string]: unknown;
};

export type Meta = {
  id: string;
  url: string;
  rewrittenUrl?: string;
  options: ScrapeOptions & { skipTlsVerification: boolean };
  internalOptions: InternalOptions;
  logger: Logger;
  abort: AbortManager;
  featureFlags: Set<FeatureFlag>;
  mock: MockState | null;
  pdfPrefetch:
    | {
        filePath: string;
        url?: string;
        status: number;
        proxyUsed: "basic" | "stealth";
        contentType?: string;
      }
    | null
    | undefined;
  documentPrefetch:
    | {
        filePath: string;
        url?: string;
        status: number;
        proxyUsed: "basic" | "stealth";
        contentType?: string;
      }
    | null
    | undefined;
  fetchPrefetch:
    | {
        url?: string;
        status: number;
        bodyBuffer: Buffer;
        proxyUsed: "basic" | "stealth";
        contentType?: string;
      }
    | null
    | undefined;
  costTracking: CostTracking;
  winnerEngine?: Engine;
  abortHandle?: NodeJS.Timeout;
  audioCookies?: BrowserCookie[];
};

export type InternalOptions = {
  teamId: string;
  crawlId?: string;
  priority?: number;
  forceEngine?: Engine | Engine[];
  atsv?: boolean;
  v0CrawlOnlyUrls?: boolean;
  v0DisableJsDom?: boolean;
  disableSmartWaitCache?: boolean;
  isBackgroundIndex?: boolean;
  externalAbort?: AbortInstance;
  urlInvisibleInCurrentCrawl?: boolean;
  unnormalizedSourceURL?: string;
  saveScrapeResultToGCS?: boolean;
  bypassBilling?: boolean;
  zeroDataRetention?: boolean;
  teamFlags?: TeamFlags;
  v1Agent?: ScrapeOptionsV1["agent"];
  v1JSONAgent?: Exclude<ScrapeOptionsV1["jsonOptions"], undefined>["agent"];
  v1JSONSystemPrompt?: string;
  v1OriginalFormat?: "extract" | "json";
  isPreCrawl?: boolean;
  agentIndexOnly?: boolean;
  isParse?: boolean;
  uploadedFile?: {
    buffer: Buffer;
    filename: string;
    contentType?: string;
    kind?: "html" | "pdf" | "document";
  };
};

const DOCUMENT_EXTENSIONS = new Set([
  ".docx",
  ".doc",
  ".odt",
  ".rtf",
  ".xlsx",
  ".xls",
]);
const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);

export function buildFeatureFlags(
  url: string,
  options: ScrapeOptions,
  internalOptions: InternalOptions,
): Set<FeatureFlag> {
  const flags: Set<FeatureFlag> = new Set();
  if (options.lockdown) {
    return flags;
  }
  if (options.actions !== undefined && options.actions.length > 0) {
    flags.add("actions");
  }
  if (hasFormatOfType(options.formats, "screenshot")) {
    if (hasFormatOfType(options.formats, "screenshot")?.fullPage) {
      flags.add("screenshot@fullScreen");
    } else {
      flags.add("screenshot");
    }
  }
  if (hasFormatOfType(options.formats, "branding")) flags.add("branding");
  if (hasFormatOfType(options.formats, "audio")) flags.add("audio");
  if (hasFormatOfType(options.formats, "video")) flags.add("video");
  if (options.waitFor !== 0) flags.add("waitFor");
  if (internalOptions.atsv) flags.add("atsv");
  if (options.location) flags.add("location");
  if (options.mobile) flags.add("mobile");
  if (options.skipTlsVerification) flags.add("skipTlsVerification");
  if (options.fastMode) flags.add("useFastMode");
  if (options.proxy === "stealth" || options.proxy === "enhanced")
    flags.add("stealthProxy");

  const urlO = new URL(url);
  const lowerPath = urlO.pathname.toLowerCase();
  const isDocument =
    lowerPath.endsWith(".docx") ||
    lowerPath.endsWith(".odt") ||
    lowerPath.endsWith(".rtf") ||
    lowerPath.endsWith(".xlsx") ||
    lowerPath.endsWith(".xls") ||
    lowerPath.includes(".docx/") ||
    lowerPath.includes(".odt/") ||
    lowerPath.includes(".rtf/") ||
    lowerPath.includes(".xlsx/") ||
    lowerPath.includes(".xls/");
  if (isDocument) flags.add("document");
  else if (lowerPath.endsWith(".pdf") || lowerPath.includes(".pdf/"))
    flags.add("pdf");
  if (options.blockAds === false) flags.add("disableAdblock");
  return flags;
}

async function writeUploadedFileToTemp(
  uploadedFilename: string,
  uploadedBuffer: Buffer,
  fallbackExtension: string,
): Promise<string> {
  const ext = path.extname(uploadedFilename).toLowerCase() || fallbackExtension;
  const safeExt = ext.startsWith(".") ? ext : `.${ext}`;
  const tempFilePath = path.join(
    tmpdir(),
    `parse-upload-${randomUUID()}${safeExt}`,
  );
  await writeFile(tempFilePath, uploadedBuffer);
  return tempFilePath;
}

function isPdfUpload(filename: string, contentType?: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const normalizedType = contentType?.toLowerCase() ?? "";
  return (
    ext === ".pdf" ||
    normalizedType === "application/pdf" ||
    normalizedType.startsWith("application/pdf;")
  );
}

function isDocumentUpload(filename: string, contentType?: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const normalizedType = contentType?.toLowerCase() ?? "";
  return (
    DOCUMENT_EXTENSIONS.has(ext) ||
    normalizedType.includes(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ) ||
    normalizedType.includes("application/vnd.ms-excel") ||
    normalizedType.includes(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ) ||
    normalizedType.includes("application/msword") ||
    normalizedType.includes("application/vnd.oasis.opendocument.text") ||
    normalizedType.includes("application/rtf") ||
    normalizedType.includes("text/rtf")
  );
}

function isHtmlUpload(filename: string, contentType?: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const normalizedType = contentType?.toLowerCase() ?? "";
  return (
    HTML_EXTENSIONS.has(ext) ||
    normalizedType.includes("text/html") ||
    normalizedType.includes("application/xhtml+xml")
  );
}

export async function buildMetaObject(
  id: string,
  url: string,
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  costTracking: CostTracking,
): Promise<Meta> {
  const specParams =
    urlSpecificParams[new URL(url).hostname.replace(/^www\./, "")];
  if (specParams !== undefined) {
    options = Object.assign(options, specParams.scrapeOptions);
    internalOptions = Object.assign(
      internalOptions,
      specParams.internalOptions,
    );
  }

  if (internalOptions.forceEngine === undefined) {
    const forcedEngine = getEngineForUrl(url);
    if (forcedEngine !== undefined) {
      internalOptions = Object.assign(internalOptions, {
        forceEngine: forcedEngine,
      });
    }
  }

  const logger = _logger.child({
    module: "ScrapeURL",
    scrapeId: id,
    scrapeURL: url,
    zeroDataRetention: internalOptions.zeroDataRetention,
    teamId: internalOptions.teamId,
    team_id: internalOptions.teamId,
    crawlId: internalOptions.crawlId,
  });

  const abortController = new AbortController();
  const abortHandle =
    options.timeout !== undefined
      ? setTimeout(
          () => abortController.abort(new ScrapeJobTimeoutError()),
          options.timeout,
        )
      : undefined;

  let pdfPrefetch: Meta["pdfPrefetch"] = undefined;
  let documentPrefetch: Meta["documentPrefetch"] = undefined;
  let fetchPrefetch: Meta["fetchPrefetch"] = undefined;

  if (internalOptions.uploadedFile) {
    const { filename, buffer, contentType } = internalOptions.uploadedFile;
    const prefetchUrl = rewriteUrl(url) ?? url;
    if (isPdfUpload(filename, contentType)) {
      const filePath = await writeUploadedFileToTemp(filename, buffer, ".pdf");
      pdfPrefetch = {
        filePath,
        status: 200,
        url: prefetchUrl,
        proxyUsed: "basic",
        contentType: contentType || "application/pdf",
      };
    } else if (isDocumentUpload(filename, contentType)) {
      const ext = path.extname(filename).toLowerCase();
      const fallbackExtension =
        ext && DOCUMENT_EXTENSIONS.has(ext) ? ext : ".docx";
      const filePath = await writeUploadedFileToTemp(
        filename,
        buffer,
        fallbackExtension,
      );
      documentPrefetch = {
        filePath,
        status: 200,
        url: prefetchUrl,
        proxyUsed: "basic",
        contentType:
          contentType ||
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      };
    } else if (isHtmlUpload(filename, contentType)) {
      fetchPrefetch = {
        url: prefetchUrl,
        status: 200,
        bodyBuffer: buffer,
        proxyUsed: "basic",
        contentType: contentType || "text/html; charset=utf-8",
      };
    } else {
      throw new UnsupportedFileError(
        contentType || path.extname(filename) || "unknown",
      );
    }
  }

  const normalizedOptions = {
    ...options,
    skipTlsVerification:
      options.skipTlsVerification ??
      ((options.headers && Object.keys(options.headers).length > 0) ||
      (options.actions && options.actions.length > 0)
        ? false
        : true),
  };

  return {
    id,
    url,
    rewrittenUrl: rewriteUrl(url),
    options: normalizedOptions,
    internalOptions,
    logger,
    abortHandle,
    abort: new AbortManager(
      internalOptions.externalAbort,
      options.timeout !== undefined
        ? {
            signal: abortController.signal,
            tier: "scrape",
            timesOutAt: new Date(Date.now() + options.timeout),
            throwable() {
              return new ScrapeJobTimeoutError();
            },
          }
        : undefined,
    ),
    featureFlags: buildFeatureFlags(url, normalizedOptions, internalOptions),
    mock:
      options.useMock !== undefined
        ? await loadMock(options.useMock, _logger)
        : null,
    pdfPrefetch,
    documentPrefetch,
    fetchPrefetch,
    costTracking,
  };
}
