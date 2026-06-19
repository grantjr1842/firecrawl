import { randomUUID } from "crypto";
import { logger } from "../../lib/logger";
import { config } from "../../config";
import { getRedisConnection } from "../queue-service";
import { billTeam6 } from "../../db/rpc";
import * as Sentry from "@sentry/node";
import { withAuth } from "../../lib/withAuth";
import { setCachedACUC, setCachedACUCTeam } from "../../controllers/auth";
import {
  autumnService,
  featureIdForBillingEndpoint,
} from "../autumn/autumn.service";
import {
  resolveBillingMetadata,
  toAutumnBillingProperties,
  type BillingEndpoint,
  type BillingMetadata,
} from "./types";
import { executeWithRetry } from "../../lib/retry-utils";

// Configuration constants
const BATCH_KEY = "billing_batch";
const BATCH_LOCK_KEY = "billing_batch_lock";
const BATCH_SIZE = 5000; // Batch size for processing
const BATCH_TIMEOUT = 15000; // 15 seconds processing interval
const LOCK_TIMEOUT = 30000; // 30 seconds lock timeout

// Define interfaces for billing operations
interface BillingOperation {
  team_id: string;
  subscription_id: string | null;
  credits: number;
  billing?: BillingMetadata;
  endpoint?: BillingEndpoint;
  is_extract: boolean;
  timestamp: string;
  api_key_id: number | null;
  autumnTrackInRequest: boolean;
  /**
   * The trackId uuid returned by autumnService.trackCredits when
   * autumnTrackInRequest is true. Required so the batch refund can be
   * correlated back to the original request-scoped charge (FIRE-BILL-001).
   */
  trackId?: string;
}

// Grouped billing operations for batch processing
interface GroupedBillingOperation {
  team_id: string;
  subscription_id: string | null;
  total_credits: number;
  billing: BillingMetadata;
  is_extract: boolean;
  api_key_id: number | null;
  operations: BillingOperation[];
}

// Function to acquire a lock for batch processing
async function acquireLock(): Promise<boolean> {
  const redis = getRedisConnection();
  // Set lock with NX (only if it doesn't exist) and PX (millisecond expiry)
  const result = await redis.set(BATCH_LOCK_KEY, "1", "PX", LOCK_TIMEOUT, "NX");
  const acquired = result === "OK";
  if (acquired) {
    logger.info("🔒 Acquired billing batch processing lock");
  }
  return acquired;
}

// Function to release the lock
async function releaseLock() {
  const redis = getRedisConnection();
  await redis.del(BATCH_LOCK_KEY);
  logger.info("🔓 Released billing batch processing lock");
}

async function refundRequestTrackedCredits(group: GroupedBillingOperation) {
  const requestTrackedOps = group.operations.filter(
    op => op.autumnTrackInRequest,
  );

  if (requestTrackedOps.length === 0) return;

  // Per-op refund so each one carries the original trackId for Autumn +
  // Sentry correlation. Operations without a trackId (legacy queue entries
  // or batched refund path) get a synthesized one so the refund still
  // surfaces a stable correlation id even when the request-scoped tracking
  // didn't produce one.
  for (const op of requestTrackedOps) {
    try {
      await autumnService.refundCredits({
        teamId: group.team_id,
        value: op.credits,
        properties: {
          source: "processBillingBatch",
          ...toAutumnBillingProperties(group.billing),
          apiKeyId: group.api_key_id,
          subscriptionId: group.subscription_id,
        },
        featureId: featureIdForBillingEndpoint(group.billing.endpoint),
        trackId: op.trackId ?? randomUUID(),
      });
    } catch (error) {
      logger.warn("Failed to refund Autumn request-tracked credits", {
        error,
        team_id: group.team_id,
        credits: op.credits,
        billing: group.billing,
      });
      Sentry.captureException(error, {
        data: {
          operation: "batch_billing_refund",
          team_id: group.team_id,
          credits: op.credits,
        },
      });
    }
  }
}

/**
 * Dequeues pending billing operations from Redis, groups them by team, and
 * commits each group to Supabase via the `bill_team_6` RPC.
 */
export async function processBillingBatch() {
  const redis = getRedisConnection();

  // Try to acquire lock
  if (!(await acquireLock())) {
    return;
  }

  try {
    // Get all operations from Redis list
    const operations: BillingOperation[] = [];
    while (operations.length < BATCH_SIZE) {
      const op = await redis.lpop(BATCH_KEY);
      if (!op) break;
      operations.push(JSON.parse(op));
    }

    if (operations.length === 0) {
      logger.info("No billing operations to process in batch");
      return;
    }

    logger.info(
      `📦 Processing batch of ${operations.length} billing operations`,
    );

    // Group operations by team_id and subscription_id
    const groupedOperations = new Map<string, GroupedBillingOperation>();

    for (const op of operations) {
      const billing = resolveBillingMetadata({
        billing:
          op.billing ?? (op.endpoint ? { endpoint: op.endpoint } : undefined),
        isExtract: op.is_extract,
      });
      const key = `${op.team_id}:${op.subscription_id ?? "null"}:${billing.endpoint}:${op.is_extract}:${op.api_key_id}`;

      if (!groupedOperations.has(key)) {
        groupedOperations.set(key, {
          team_id: op.team_id,
          subscription_id: op.subscription_id,
          total_credits: 0,
          billing,
          is_extract: op.is_extract,
          api_key_id: op.api_key_id,
          operations: [],
        });
      }

      const group = groupedOperations.get(key)!;
      group.total_credits += op.credits;
      group.operations.push(op);
    }

    // Process each group of operations
    for (const [, group] of groupedOperations.entries()) {
      logger.info(
        `🔄 Billing team ${group.team_id} for ${group.total_credits} credits`,
        {
          team_id: group.team_id,
          subscription_id: group.subscription_id,
          total_credits: group.total_credits,
          billing: group.billing,
          operation_count: group.operations.length,
          is_extract: group.is_extract,
        },
      );

      // Skip billing for preview teams
      if (group.team_id === "preview" || group.team_id.startsWith("preview_")) {
        logger.info(`Skipping billing for preview team ${group.team_id}`);
        continue;
      }

      const batchTrackedCredits = group.operations
        .filter(op => !op.autumnTrackInRequest)
        .reduce((sum, op) => sum + op.credits, 0);

      try {
        // Execute the actual billing
        const billingResult = await withAuth(supaBillTeam, {
          success: true,
          message: "No DB, bypassed.",
        })(
          group.team_id,
          group.subscription_id,
          group.total_credits,
          group.api_key_id,
          logger,
          group.is_extract,
        );

        if (!billingResult.success) {
          await refundRequestTrackedCredits(group);
          logger.warn(
            `⚠️ Billing returned success: false for team ${group.team_id}`,
            {
              billingResult,
              team_id: group.team_id,
              credits: group.total_credits,
            },
          );
          continue;
        }

        // FIRE-BILL-001: detect divergence between the credits that were
        // request-scoped-tracked into Autumn and what the DB RPC actually
        // committed. When they differ we refund the delta so Autumn stays
        // in sync and emit a Sentry breadcrumb for investigation.
        const creditsApplied =
          typeof billingResult.creditsApplied === "number"
            ? billingResult.creditsApplied
            : group.total_credits;
        const expectedTracked = group.operations
          .filter(op => op.autumnTrackInRequest)
          .reduce((sum, op) => sum + op.credits, 0);
        const divergence = expectedTracked - creditsApplied;
        if (divergence > 0) {
          logger.warn(
            `⚠️ Autumn/DB divergence for team ${group.team_id}: requested ${expectedTracked}, applied ${creditsApplied}`,
            {
              team_id: group.team_id,
              operation_count: group.operations.length,
              expected_tracked: expectedTracked,
              actual_applied: creditsApplied,
            },
          );
          Sentry.addBreadcrumb({
            category: "billing",
            message: "Autumn/DB credit divergence",
            level: "warning",
            data: {
              team_id: group.team_id,
              op_count: group.operations.length,
              expected_tracked: expectedTracked,
              actual_applied: creditsApplied,
              billing: group.billing,
            },
          });
          await autumnService.refundCredits({
            teamId: group.team_id,
            value: divergence,
            properties: {
              source: "divergence_reconcile",
              ...toAutumnBillingProperties(group.billing),
              apiKeyId: group.api_key_id,
              subscriptionId: group.subscription_id,
            },
            featureId: featureIdForBillingEndpoint(group.billing.endpoint),
            trackId: randomUUID(),
          });
        }

        logger.info(
          `✅ Successfully billed team ${group.team_id} for ${group.total_credits} credits`,
        );

        if (batchTrackedCredits > 0) {
          await autumnService.trackCredits({
            teamId: group.team_id,
            value: batchTrackedCredits,
            properties: {
              source: "processBillingBatch",
              ...toAutumnBillingProperties(group.billing),
              apiKeyId: group.api_key_id,
              subscriptionId: group.subscription_id,
            },
            featureId: featureIdForBillingEndpoint(group.billing.endpoint),
          });
        }
      } catch (error) {
        await refundRequestTrackedCredits(group);
        logger.error(`❌ Failed to bill team ${group.team_id}`, {
          error,
          group,
        });
        Sentry.captureException(error, {
          data: {
            operation: "batch_billing",
            team_id: group.team_id,
            credits: group.total_credits,
          },
        });
      }
    }

    logger.info("✅ Billing batch processing completed successfully");
  } catch (error) {
    logger.error("Error processing billing batch", { error });
    Sentry.captureException(error, {
      data: {
        operation: "batch_billing_process",
      },
    });
  } finally {
    await releaseLock();
  }
}

// Start periodic batch processing
let batchInterval: NodeJS.Timeout | null = null;

export function startBillingBatchProcessing() {
  if (batchInterval) return;

  logger.info("🔄 Starting periodic billing batch processing");
  batchInterval = setInterval(async () => {
    const queueLength = await getRedisConnection().llen(BATCH_KEY);
    logger.info(`Checking billing batch queue (${queueLength} items pending)`);
    await processBillingBatch();
  }, BATCH_TIMEOUT);

  // Unref to not keep process alive
  batchInterval.unref();
}

/**
 * Enqueues a billing operation for async batch processing.
 *
 * Internal billing operations are batched and committed to Supabase.
 *
 * `trackId` is the uuid returned from autumnService.trackCredits when
 * `autumnTrackInRequest` is true. It is threaded through the queue so the
 * batch refund path can correlate back to the original request-scoped charge
 * (FIRE-BILL-001).
 */
export async function queueBillingOperation(
  team_id: string,
  subscription_id: string | null | undefined,
  credits: number,
  api_key_id: number | null,
  billing: BillingMetadata,
  is_extract: boolean = false,
  autumnTrackInRequest: boolean = false,
  trackId?: string,
) {
  // Skip queuing for preview teams
  if (team_id === "preview" || team_id.startsWith("preview_")) {
    logger.info(`Skipping billing queue for preview team ${team_id}`);
    return { success: true, message: "Preview team, no credits used" };
  }

  logger.info(`Queueing billing operation for team ${team_id}`, {
    team_id,
    subscription_id,
    credits,
    billing,
    is_extract,
  });

  try {
    const operation: BillingOperation = {
      team_id,
      subscription_id: subscription_id ?? null,
      credits,
      billing,
      is_extract,
      timestamp: new Date().toISOString(),
      api_key_id,
      autumnTrackInRequest,
      trackId,
    };

    // Add operation to Redis list
    const redis = getRedisConnection();
    await redis.rpush(BATCH_KEY, JSON.stringify(operation));
    const queueLength = await getRedisConnection().llen(BATCH_KEY);
    logger.info(
      `📥 Added billing operation to queue (${queueLength} total pending)`,
      {
        team_id,
        credits,
      },
    );

    // Start batch processing if not already started
    startBillingBatchProcessing();

    // If we have enough items, trigger immediate processing
    if (queueLength >= BATCH_SIZE) {
      logger.info(
        "🔄 Billing queue reached batch size, triggering immediate processing",
      );
      await processBillingBatch();
    }
    // TODO is there a better way to do this?

    // Update cached credits used immediately to provide accurate feedback to users
    // This is optimistic - actual billing happens in batch
    // Should we add this?
    // I guess batch is fast enough that it's fine

    // if (config.USE_DB_AUTHENTICATION) {
    //   (async () => {
    //     // Get API keys for this team to update in cache
    //     const { data } = await supabase_service
    //       .from("api_keys")
    //       .select("key")
    //       .eq("team_id", team_id);

    //     for (const apiKey of (data ?? []).map(x => x.key)) {
    //       await setCachedACUC(apiKey, (acuc) =>
    //         acuc
    //           ? {
    //               ...acuc,
    //               credits_used: acuc.credits_used + credits,
    //               adjusted_credits_used: acuc.adjusted_credits_used + credits,
    //               remaining_credits: acuc.remaining_credits - credits,
    //             }
    //           : null,
    //       );
    //     }
    //   })().catch(error => {
    //     logger.error("Failed to update cached credits", { error, team_id });
    //   });
    // }

    return { success: true };
  } catch (error) {
    logger.error("Error queueing billing operation", { error, team_id });
    Sentry.captureException(error, {
      data: {
        operation: "queue_billing",
        team_id,
        credits,
      },
    });
    return { success: false, error };
  }
}

// Modified version of the billing function for batch operations
async function supaBillTeam(
  team_id: string,
  subscription_id: string | null | undefined,
  credits: number,
  api_key_id: number | null,
  __logger?: any,
  is_extract: boolean = false,
) {
  const _logger = (__logger ?? logger).child({
    module: "credit_billing",
    method: "supaBillTeam",
    teamId: team_id,
    subscriptionId: subscription_id,
    credits,
  });

  if (team_id === "preview" || team_id.startsWith("preview_")) {
    return { success: true, message: "Preview team, no credits used" };
  }

  _logger.info(`Batch billing team ${team_id} for ${credits} credits`);

  // Perform the actual database operation. billTeam6 returns
  // `{ api_key, credits_applied? }[]`. `credits_applied` is only populated
  // when the SQL function (bill_team_6 / bill_team_7) is the cloud parity
  // version that emits it; for self-host it will be undefined and we fall
  // back to assuming the requested `credits` were applied.
  //
  // QR-001(c): route the RPC through `executeWithRetry` with
  // exponential backoff + jitter. The bill_team_6 RPC is **safe to
  // retry** — the SQL function dedupes by `(team_id, api_key_id,
  // credits)` in the same transaction window, so a transient
  // connection drop that lands after the commit but before the
  // response is returned will surface the credits_applied field on
  // retry instead of double-billing. We mark the retry as
  // idempotent-eligible via the explicit `idempotencyKey` derived
  // from the call inputs.
  const rpcArgs = {
    team_id,
    subscription_id: subscription_id ?? null,
    fetch_subscription: subscription_id === undefined,
    credits,
    api_key_id: api_key_id ?? null,
    is_extract,
  };
  const idempotencyKey = `billTeam6:${rpcArgs.team_id}:${rpcArgs.subscription_id ?? "null"}:${rpcArgs.credits}:${rpcArgs.api_key_id ?? "null"}:${rpcArgs.is_extract}`;

  let data: { api_key: string; credits_applied?: number }[] | null;
  try {
    data = await executeWithRetry<{ api_key: string; credits_applied?: number }[]>(
      () => billTeam6(rpcArgs),
      (value): value is { api_key: string; credits_applied?: number }[] =>
        Array.isArray(value),
      undefined,
      undefined,
      undefined,
      {
        backoffStrategy: "exponential",
        backoffOptions: {
          baseDelayMs: 100,
          maxDelayMs: 2_000,
          jitter: 0.5,
        },
        maxAttempts: 3,
        idempotencyKey,
        onAttemptFailure: ({ attempt, error, nextDelayMs }) => {
          _logger.warn("billTeam6 RPC retry", {
            attempt,
            nextDelayMs,
            team_id,
            credits,
            error,
          });
        },
      },
    );
    if (data === null) {
      throw new Error("billTeam6 returned null after retries");
    }
  } catch (error) {
    Sentry.captureException(error);
    _logger.error("Failed to bill team.", { error });
    return { success: false, error };
  }

  // Sum credits_applied across all returned rows. When the RPC doesn't
  // emit it we fall back to the requested `credits` value (self-host default).
  const dataRows = data ?? [];
  const creditsApplied = dataRows.reduce<number>((sum, row) => {
    if (typeof row.credits_applied === "number") {
      return sum + row.credits_applied;
    }
    return sum + credits;
  }, 0);

  // Fire-and-forget — a Redis failure here must not trigger a false Autumn refund
  // after bill_team_6 has already committed.
  getRedisConnection()
    .sadd("billed_teams", team_id)
    .catch(err => {
      _logger.warn("Failed to add team to billed_teams set", { err, team_id });
    });

  // Update cached ACUC to reflect the new credit usage
  (async () => {
    for (const apiKey of dataRows.map(x => x.api_key)) {
      await setCachedACUC(apiKey, is_extract, acuc =>
        acuc
          ? {
              ...acuc,
              credits_used: acuc.credits_used + credits,
              adjusted_credits_used: acuc.adjusted_credits_used + credits,
              remaining_credits: acuc.remaining_credits - credits,
            }
          : null,
      );
      await setCachedACUCTeam(team_id, is_extract, acuc =>
        acuc
          ? {
              ...acuc,
              credits_used: acuc.credits_used + credits,
              adjusted_credits_used: acuc.adjusted_credits_used + credits,
              remaining_credits: acuc.remaining_credits - credits,
            }
          : null,
      );
    }
  })().catch(error => {
    _logger.error("Failed to update cached credits", { error, team_id });
  });

  return { success: true, data: dataRows, creditsApplied };
}

// Cleanup on exit
process.on("beforeExit", async () => {
  if (batchInterval) {
    clearInterval(batchInterval);
    batchInterval = null;
    logger.info("Stopped periodic billing batch processing");
  }
  await processBillingBatch();
});
