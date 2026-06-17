import { z } from "zod";
import {
  BaseScrapeOptions,
  ScrapeOptions,
  Document as V2Document,
  TeamFlags,
} from "./controllers/v2/types";
import { AuthCreditUsageChunk } from "./controllers/v1/types";
import { ExtractorOptions, Document } from "./lib/entities";
import { InternalOptions } from "./scraper/scrapeURL";
import type { CostTracking } from "./lib/cost-tracking";
import type { BillingMetadata } from "./services/billing/types";
import { webhookSchema } from "./services/webhook/schema";
import { SerializedTraceContext } from "./lib/otel-tracer";

type ScrapeJobCommon = {
  concurrencyLimited?: boolean;
  team_id: string;
  zeroDataRetention: boolean;
  billing?: BillingMetadata;
  keylessReserved?: boolean;
  traceContext?: SerializedTraceContext;
  skipNuq?: boolean;
  requestId?: string;
  monitoring?: {
    monitorId: string;
    checkId: string;
    targetId: string;
    source: "explicit" | "discovered";
  };
};

export type ScrapeJobData = ScrapeJobCommon &
  (
    | ScrapeJobSingleUrlsUnique
    | ScrapeJobKickoffUnique
    | ScrapeJobKickoffSitemapUnique
  );

type ScrapeJobSingleUrlsUnique = {
  mode: "single_urls";

  url: string;
  crawlerOptions?: any;
  scrapeOptions: BaseScrapeOptions;
  internalOptions?: InternalOptions;
  origin: string;
  crawl_id?: string;
  sitemapped?: boolean;
  webhook?: z.infer<typeof webhookSchema>;
  v1?: boolean;
  integration?: string | null;

  /**
   * Disables billing on the worker side.
   */
  is_scrape?: boolean;

  isCrawlSourceScrape?: boolean;
  from_extract?: boolean;
  startTime?: number;

  sentry?: any;
  is_extract?: boolean;
  apiKeyId: number | null;

  logRequestPromise?: Promise<any>;
};

export type ScrapeJobSingleUrls = ScrapeJobCommon & ScrapeJobSingleUrlsUnique;

type ScrapeJobKickoffUnique = {
  mode: "kickoff";

  url: string;
  crawlerOptions?: any;
  scrapeOptions: BaseScrapeOptions;
  internalOptions?: InternalOptions;
  origin: string;
  integration?: string | null;
  crawl_id: string;
  webhook?: z.infer<typeof webhookSchema>;
  v1: boolean;
  apiKeyId: number | null;
};

export type ScrapeJobKickoff = ScrapeJobCommon & ScrapeJobKickoffUnique;

type ScrapeJobKickoffSitemapUnique = {
  mode: "kickoff_sitemap";

  crawl_id: string;
  sitemapUrl: string;
  location?: ScrapeOptions["location"];
  origin: string;
  integration?: string | null;
  webhook?: z.infer<typeof webhookSchema>;
  v1: boolean;
  apiKeyId: number | null;
};

export type ScrapeJobKickoffSitemap = ScrapeJobCommon &
  ScrapeJobKickoffSitemapUnique;

export interface RunWebScraperParams {
  url: string;
  scrapeOptions: ScrapeOptions;
  internalOptions?: InternalOptions;
  team_id: string;
  bull_job_id: string;
  priority?: number;
  is_crawl?: boolean;
  urlInvisibleInCurrentCrawl?: boolean;
  costTracking: CostTracking;
}

export interface FirecrawlScrapeResponse {
  statusCode: number;
  body: {
    status: string;
    data: Document;
  };
  error?: string;
}

export interface FirecrawlCrawlResponse {
  statusCode: number;
  body: {
    status: string;
    jobId: string;
  };
  error?: string;
}

export interface FirecrawlCrawlStatusResponse {
  statusCode: number;
  body: {
    status: string;
    data: Document[];
  };
  error?: string;
}

/**
 * Canonical ACUC shape produced by self-hosted mocks (TypeScript
 * `mockACUC` in `controllers/auth.ts` and the PL/pgSQL
 * `auth_credit_usage_chunk_47` function in
 * `drizzle/0021_cloud_rpcs_remaining.sql`).
 *
 * Self-hosted deployments must populate every key — never
 * `undefined` — so the rate-limiter middleware (`getRateLimiter` in
 * `services/rate-limiter.ts`) can safely destructure any
 * `RateLimiterMode` value without silently reading `undefined` and
 * falling back to the conservative `500` cap. The 10 keys here
 * are the union of the keys the TS mock and the SQL mock historically
 * produced; DB-RPC-006 aligns the two mocks on this exact set.
 *
 * Optional fields that are NOT used on the self-hosted hot path
 * (browser / account / support / research) are intentionally
 * excluded from this type so a regression in either mock surfaces
 * as a TypeScript error rather than a silent `undefined`.
 */
export type SelfHostACUC = {
  rate_limits: {
    crawl: number;
    scrape: number;
    search: number;
    map: number;
    extract: number;
    preview: number;
    crawlStatus: number;
    extractStatus: number;
    extractAgentPreview: number;
    scrapeAgentPreview: number;
  };
};

export enum RateLimiterMode {
  Crawl = "crawl",
  CrawlStatus = "crawlStatus",
  Scrape = "scrape",
  ScrapeAgentPreview = "scrapeAgentPreview",
  Preview = "preview",
  Search = "search",
  Map = "map",
  Extract = "extract",
  ExtractStatus = "extractStatus",
  ExtractAgentPreview = "extractAgentPreview",
  Browser = "browser",
  BrowserExecute = "browserExecute",
  Account = "account",
  SupportAsk = "supportAsk",
  SupportDocsSearch = "supportDocsSearch",
  Research = "research",
}

export type AuthResponse =
  | {
      success: true;
      team_id: string;
      org_id?: string | null;
      api_key?: string;
      chunk: AuthCreditUsageChunk | null;
    }
  | {
      success: false;
      error: string;
      status: number;
      // When true, send the agent OAuth-discovery WWW-Authenticate header even on
      // non-401 responses (e.g. keyless cap 429s) so agents can find the key flow.
      agentAuthDiscovery?: boolean;
    };

export enum NotificationType {
  RATE_LIMIT_REACHED = "rateLimitReached",
  AUTO_RECHARGE_SUCCESS = "autoRechargeSuccess",
  AUTO_RECHARGE_FAILED = "autoRechargeFailed",
  CONCURRENCY_LIMIT_REACHED = "concurrencyLimitReached",
  AUTO_RECHARGE_FREQUENT = "autoRechargeFrequent",
  AGENT_SPONSOR_CONFIRM = "agentSponsorConfirm",
}
