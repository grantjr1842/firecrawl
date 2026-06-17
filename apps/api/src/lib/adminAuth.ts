import type { NextFunction, Request, Response } from "express";
import * as Sentry from "@sentry/node";
import { logger } from "./logger";
import { config } from "../config";

const MUTATING_METHODS = new Set(["POST", "DELETE", "PUT", "PATCH"]);
const ACTOR_HEADER = "x-admin-actor-email";
const TARGET_HEADER = "x-admin-target";

/**
 * In-memory, per-process rate limiter for admin endpoints.
 *
 * Designed for the simplest possible guard against a compromised
 * BULL_AUTH_KEY being used to wipe state in a tight loop. Multi-process
 * deployments are out of scope; Redis-backed rate-limiter.ts is used elsewhere
 * for cross-process enforcement.
 */
type RateLimitBucket = {
  windowStartedAt: number;
  count: number;
};

const rateLimitBuckets = new Map<string, RateLimitBucket>();

export function resetAdminRateLimits(): void {
  rateLimitBuckets.clear();
}

export function adminRateLimit(
  key: string,
  windowMs: number,
  max: number,
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const existing = rateLimitBuckets.get(key);

  if (!existing || now - existing.windowStartedAt >= windowMs) {
    rateLimitBuckets.set(key, { windowStartedAt: now, count: 1 });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (existing.count >= max) {
    return {
      allowed: false,
      retryAfterMs: existing.windowStartedAt + windowMs - now,
    };
  }

  existing.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

// Periodic cleanup of stale buckets so the Map doesn't grow unbounded
// across long-running processes. Runs every 5 minutes; entries older than
// 1 hour are dropped.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStartedAt >= STALE_AFTER_MS) {
      rateLimitBuckets.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS);
// Don't keep the event loop alive just for cleanup
if (typeof cleanupTimer.unref === "function") {
  cleanupTimer.unref();
}

function recordAdminAudit(entry: {
  actor: string | null;
  action: string;
  target: string | null;
  method: string;
  path: string;
  ip: string;
  status: number;
  rateLimited?: boolean;
}) {
  // log_job table is for product telemetry (scrapes/crawls/extracts) — admin
  // audit rows are a different shape (no team_id, no credit cost). Write them
  // as structured winston logs that ops can ship to a SIEM. Keep the payload
  // small and well-tagged.
  logger.info("admin_action", {
    module: "adminAuth",
    method: "adminAuthMiddleware",
    canonicalLog: "admin/action",
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    method: entry.method,
    path: entry.path,
    ip: entry.ip,
    status: entry.status,
    rate_limited: entry.rateLimited === true,
  });
}

export function emitAdminBreadcrumb(entry: {
  actor: string | null;
  action: string;
  target: string | null;
  ip: string;
}): void {
  if (!config.SENTRY_DSN) {
    return;
  }

  Sentry.addBreadcrumb({
    category: "admin",
    message: `admin.${entry.action}`,
    level: "warning",
    data: {
      actor: entry.actor ?? "<missing>",
      target: entry.target ?? "<none>",
      ip: entry.ip,
    },
  });
}

/**
 * Express middleware for /admin/* endpoints.
 *
 * - On mutating methods (POST/DELETE/PUT/PATCH), requires `X-Admin-Actor-Email`
 *   header to identify the human/automation making the change. Missing header
 *   returns 400 `admin_actor_required`.
 * - On every request, emits a Sentry breadcrumb (when Sentry is configured)
 *   with tags `{actor, action, target, ip}` and writes a structured
 *   `admin_action` log line so the call leaves an audit trail.
 *
 * `action` defaults to the request path minus the BULL_AUTH_KEY prefix;
 * `target` is taken from `X-Admin-Target` header if present, else the
 * request body's `team_id` (commonly used for team-scoped admin actions like
 * acuc-cache-clear).
 *
 * NOTE: bull-board UI is mounted separately on `/admin/{BULL_AUTH_KEY}/queues`
 * via `app.use(...)` in index.ts — it never reaches this router, so the
 * `X-Admin-Actor-Email` requirement on mutating methods does not block UI use.
 */
export function adminAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const actorRaw = req.headers[ACTOR_HEADER];
  const actor =
    typeof actorRaw === "string" && actorRaw.trim().length > 0
      ? actorRaw.trim()
      : null;

  const targetHeader = req.headers[TARGET_HEADER];
  const target =
    typeof targetHeader === "string" && targetHeader.trim().length > 0
      ? targetHeader.trim()
      : ((req.body as any)?.team_id ?? null) || null;

  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    "unknown";

  const action = req.path || req.baseUrl || "unknown";
  const method = req.method ?? "UNKNOWN";

  if (MUTATING_METHODS.has(method.toUpperCase()) && !actor) {
    recordAdminAudit({
      actor,
      action,
      target,
      method,
      path: req.originalUrl ?? req.path,
      ip,
      status: 400,
    });
    res.status(400).json({
      success: false,
      error: "admin_actor_required",
      message: `Mutating admin endpoints require the '${ACTOR_HEADER}' header.`,
    });
    return;
  }

  emitAdminBreadcrumb({ actor, action, target, ip });
  recordAdminAudit({
    actor,
    action,
    target,
    method,
    path: req.originalUrl ?? req.path,
    ip,
    status: 200,
  });

  // Stash on req for downstream controllers (avoids re-parsing the header).
  (req as any).adminActor = actor;
  (req as any).adminTarget = target;
  (req as any).adminIp = ip;

  next();
}

/**
 * Apply a per-BULL_AUTH_KEY rate limit to a specific admin endpoint.
 * Defaults: 1 call / 10s per BULL_AUTH_KEY.
 */
export function adminRateLimitMiddleware(
  windowMs: number = 10_000,
  max: number = 1,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // The BULL_AUTH_KEY appears in the URL itself, so use it as the
    // partition key — every holder of the secret shares the same bucket,
    // which is what we want for "a compromised secret can't wipe state in
    // a tight loop".
    const key = `${config.BULL_AUTH_KEY ?? "unknown"}:${req.path}`;

    const result = adminRateLimit(key, windowMs, max);
    if (!result.allowed) {
      const actorRaw = req.headers[ACTOR_HEADER];
      const actor =
        typeof actorRaw === "string" && actorRaw.trim().length > 0
          ? actorRaw.trim()
          : null;
      const ip =
        (req.headers["x-forwarded-for"] as string | undefined)
          ?.split(",")[0]
          ?.trim() || req.ip || "unknown";
      recordAdminAudit({
        actor,
        action: req.path,
        target: ((req.body as any)?.team_id ?? null) || null,
        method: req.method ?? "UNKNOWN",
        path: req.originalUrl ?? req.path,
        ip,
        status: 429,
        rateLimited: true,
      });
      res
        .status(429)
        .set("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)))
        .json({
          success: false,
          error: "admin_rate_limited",
          message: `Too many admin calls. Retry in ${Math.ceil(result.retryAfterMs / 1000)}s.`,
        });
      return;
    }
    next();
  };
}