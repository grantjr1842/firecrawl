import express from "express";
import { config } from "../config";
import { redisHealthController } from "../controllers/v0/admin/redis-health";
import { autumnHealthController } from "../controllers/v0/admin/autumn-health";
import { authMiddleware, checkCreditsMiddleware, wrap } from "./shared";
import { acucCacheClearController } from "../controllers/v0/admin/acuc-cache-clear";
import { checkFireEngine } from "../controllers/v0/admin/check-fire-engine";
import { cclogController } from "../controllers/v0/admin/cclog";
import { indexQueuePrometheus } from "../controllers/v0/admin/index-queue-prometheus";
import { triggerPrecrawl } from "../controllers/v0/admin/precrawl";
import {
  metricsController,
  nuqMetricsController,
} from "../controllers/v0/admin/metrics";
import { realtimeSearchController } from "../controllers/v2/f-search";
import { concurrencyQueueBackfillController } from "../controllers/v0/admin/concurrency-queue-backfill";
import { crawlMonitorController } from "../controllers/v0/admin/crawl-monitor";
import {
  handleIntegrationAdminCreateUserProxy,
  handleIntegrationAdminRotateProxy,
  handleIntegrationAdminValidateProxy,
} from "../lib/admin-integration-integrations-proxy";
import {
  adminAuthMiddleware,
  adminRateLimitMiddleware,
} from "../lib/adminAuth";
import { RateLimiterMode } from "../types";

export const adminRouter = express.Router();

// Audit + actor-identity enforcement applies to every /admin/* route.
// The bull-board UI is mounted on `/admin/{BULL_AUTH_KEY}/queues` directly
// via app.use() in index.ts and bypasses this router, so the
// `X-Admin-Actor-Email` requirement on mutating methods does not affect the UI.
adminRouter.use(adminAuthMiddleware);

adminRouter.get(
  `/admin/${config.BULL_AUTH_KEY}/redis-health`,
  redisHealthController,
);

adminRouter.get(
  `/admin/${config.BULL_AUTH_KEY}/autumn-health`,
  autumnHealthController,
);

// acuc-cache-clear wipes every API key's cached chunk for the given team_id,
// so in addition to the actor-identity check we rate-limit to 1 call / 10s
// per BULL_AUTH_KEY. See auth-rbac-6.
adminRouter.post(
  `/admin/${config.BULL_AUTH_KEY}/acuc-cache-clear`,
  adminRateLimitMiddleware(10_000, 1),
  wrap(acucCacheClearController),
);

adminRouter.get(
  `/admin/${config.BULL_AUTH_KEY}/feng-check`,
  wrap(checkFireEngine),
);

adminRouter.get(`/admin/${config.BULL_AUTH_KEY}/cclog`, wrap(cclogController));

adminRouter.get(
  `/admin/${config.BULL_AUTH_KEY}/index-queue-prometheus`,
  wrap(indexQueuePrometheus),
);

adminRouter.get(
  `/admin/${config.BULL_AUTH_KEY}/precrawl`,
  wrap(triggerPrecrawl),
);

adminRouter.get(
  `/admin/${config.BULL_AUTH_KEY}/metrics`,
  wrap(metricsController),
);

adminRouter.get(
  `/admin/${config.BULL_AUTH_KEY}/nuq-metrics`,
  wrap(nuqMetricsController),
);

adminRouter.post(
  `/admin/${config.BULL_AUTH_KEY}/fsearch`,
  wrap(realtimeSearchController),
);

adminRouter.post(
  `/admin/${config.BULL_AUTH_KEY}/concurrency-queue-backfill`,
  wrap(concurrencyQueueBackfillController),
);

adminRouter.post(
  `/admin/${config.BULL_AUTH_KEY}/crawl-monitor`,
  authMiddleware(RateLimiterMode.Crawl),
  checkCreditsMiddleware(2),
  wrap(crawlMonitorController),
);

adminRouter.post(
  `/admin/integration/create-user`,
  wrap(handleIntegrationAdminCreateUserProxy),
);

adminRouter.post(
  `/admin/integration/validate-api-key`,
  wrap(handleIntegrationAdminValidateProxy),
);

adminRouter.post(
  `/admin/integration/rotate-api-key`,
  wrap(handleIntegrationAdminRotateProxy),
);