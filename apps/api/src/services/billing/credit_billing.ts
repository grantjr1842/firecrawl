import { withAuth } from "../../lib/withAuth";
import { logger, devTrace } from "../../lib/logger";
import * as Sentry from "@sentry/node";
import { AuthCreditUsageChunk } from "../../controllers/v1/types";
import { queueBillingOperation } from "./batch_billing";
import {
  autumnService,
  featureIdForBillingEndpoint,
} from "../autumn/autumn.service";
import { toAutumnBillingProperties, type BillingMetadata } from "./types";
import type { Logger } from "winston";

/**
 * Result shape returned by `billTeam` to the controller.
 *
 * - `success`: whether the DB commit (or no-DB bypass) completed.
 * - `trackId`: the uuid returned by autumnService.trackCredits when
 *   request-scoped tracking succeeded. Callers may use it for downstream
 *   reconciliation; not required by any current caller.
 * - `divergent`: true when trackCredits succeeded but the DB commit
 *   applied a different number of credits. The batch worker will reconcile
 *   the delta; this flag is surfaced for telemetry only.
 *
 * Callers that don't read the new fields are unaffected — TypeScript
 * structural typing keeps existing destructuring compatible.
 */
export type BillTeamResult = {
  success: boolean;
  message?: string;
  trackId?: string;
  divergent?: boolean;
  error?: unknown;
};

/**
 * If you do not know the subscription_id in the current context, pass subscription_id as undefined.
 */
export async function billTeam(
  team_id: string,
  subscription_id: string | null | undefined,
  credits: number,
  api_key_id: number | null,
  billing: BillingMetadata,
  logger?: Logger,
): Promise<BillTeamResult> {
  return withAuth(
    async (
      team_id: string,
      subscription_id: string | null | undefined,
      credits: number,
      api_key_id: number | null,
      billing: BillingMetadata,
      logger: Logger | undefined,
    ) => {
      const autumnProperties = {
        source: "billTeam",
        ...toAutumnBillingProperties(billing),
        apiKeyId: api_key_id,
      };
      const featureId = featureIdForBillingEndpoint(billing.endpoint);
      const trackId = await autumnService.trackCredits({
        teamId: team_id,
        value: credits,
        properties: autumnProperties,
        requestScoped: true,
        featureId,
      });
      const trackedInRequest = trackId !== null;

      const result = await queueBillingOperation(
        team_id,
        subscription_id,
        credits,
        api_key_id,
        billing,
        false,
        trackedInRequest,
        trackId ?? undefined,
      );

      // FIRE-BILL-001: if Autumn tracked the request-scoped charge but the
      // queue refused to enqueue, refund that single op immediately so the
      // caller is not silently over-charged.
      if (!result.success && trackedInRequest && trackId) {
        await autumnService.refundCredits({
          teamId: team_id,
          value: credits,
          properties: autumnProperties,
          featureId,
          trackId,
        });
        Sentry.addBreadcrumb({
          category: "billing",
          message: "billTeam queue failure after Autumn track",
          level: "warning",
          data: {
            team_id,
            credits,
            trackId,
          },
        });
      }

      // FIRE-BILL-001: when the request scope silently failed to track
      // (trackId === null but queue succeeded), emit a breadcrumb so the
      // batch worker can flag this team as under-counted in Autumn.
      let divergent: boolean | undefined;
      if (result.success && !trackedInRequest) {
        divergent = true;
        Sentry.addBreadcrumb({
          category: "billing",
          message: "Autumn track skipped while DB bill succeeded",
          level: "warning",
          data: {
            team_id,
            credits,
            billing,
          },
        });
      }

      devTrace("scrape.billing.charged", {
        teamId: team_id,
        credits,
        apiKeyId: api_key_id,
        endpoint: billing.endpoint,
        jobId: billing.jobId,
        success: result.success,
        divergent,
        trackId: trackId ?? undefined,
      });

      return {
        success: result.success,
        message: (result as { message?: string }).message,
        error: (result as { error?: unknown }).error,
        trackId: trackId ?? undefined,
        divergent,
      };
    },
    {
      success: true,
      message: "No DB, bypassed.",
    } as BillTeamResult,
  )(team_id, subscription_id, credits, api_key_id, billing, logger);
}

type CheckTeamCreditsResponse = {
  success: boolean;
  message: string;
  remainingCredits: number;
  chunk?: AuthCreditUsageChunk;
};

export async function checkTeamCredits(
  chunk: AuthCreditUsageChunk | null,
  team_id: string,
  credits: number,
): Promise<CheckTeamCreditsResponse> {
  return withAuth(supaCheckTeamCredits, {
    success: true,
    message: "No DB, bypassed",
    remainingCredits: Infinity,
  })(chunk, team_id, credits);
}

function evaluateTeamCredits(
  chunk: AuthCreditUsageChunk,
  credits: number,
  isAutoRechargeEnabled: boolean,
) {
  const allowOverages = chunk.price_should_be_graceful && isAutoRechargeEnabled;
  const remainingCredits = allowOverages
    ? chunk.remaining_credits + chunk.price_credits
    : chunk.remaining_credits;
  const creditsWillBeUsed = chunk.adjusted_credits_used + credits;
  const totalPriceCredits = allowOverages
    ? (chunk.total_credits_sum ?? 100000000) + chunk.price_credits
    : (chunk.total_credits_sum ?? 100000000);
  const creditUsagePercentage =
    chunk.adjusted_credits_used / (chunk.total_credits_sum ?? 100000000);

  return {
    allowOverages,
    remainingCredits,
    creditsWillBeUsed,
    totalPriceCredits,
    creditUsagePercentage,
    success: creditsWillBeUsed <= totalPriceCredits,
  };
}

// if team has enough credits for the operation, return true, else return false
async function supaCheckTeamCredits(
  chunk: AuthCreditUsageChunk | null,
  team_id: string,
  credits: number,
): Promise<CheckTeamCreditsResponse> {
  // WARNING: chunk will be null if team_id is preview -- do not perform operations on it under ANY circumstances - mogery
  if (team_id === "preview" || team_id.startsWith("preview_")) {
    return {
      success: true,
      message: "Preview team, no credits used",
      remainingCredits: Infinity,
    };
  } else if (chunk === null) {
    throw new Error("NULL ACUC passed to supaCheckTeamCredits");
  }

  // If bypassCreditChecks flag is set, return success with infinite credits (infinitely graceful)
  if (chunk.flags?.bypassCreditChecks) {
    return {
      success: true,
      message: "Credit checks bypassed",
      remainingCredits: Infinity,
      chunk,
    };
  }

  // Auto-recharge is now handled entirely by Autumn. The legacy ACUC-driven
  // auto-recharge logic below is disabled to avoid double-charging or firing
  // at the wrong threshold.
  //
  // let isAutoRechargeEnabled = false,
  //   autoRechargeThreshold = 1000;
  // const cacheKey = `team_auto_recharge_${team_id}`;
  // let cachedData = await getValue(cacheKey);
  // if (cachedData) {
  //   const parsedData = JSON.parse(cachedData);
  //   isAutoRechargeEnabled = parsedData.auto_recharge;
  //   autoRechargeThreshold = parsedData.auto_recharge_threshold;
  // } else {
  //   const { data, error } = await supabase_rr_service
  //     .from("teams")
  //     .select("auto_recharge, auto_recharge_threshold")
  //     .eq("id", team_id)
  //     .single();
  //
  //   if (data) {
  //     isAutoRechargeEnabled = data.auto_recharge;
  //     autoRechargeThreshold = data.auto_recharge_threshold;
  //     await setValue(cacheKey, JSON.stringify(data), 300);
  //   }
  // }

  const {
    success,
    remainingCredits,
    creditsWillBeUsed,
    totalPriceCredits,
    creditUsagePercentage,
  } = evaluateTeamCredits(chunk, credits, false);

  // if (
  //   config.AUTO_RECHARGE_ENABLED &&
  //   isAutoRechargeEnabled &&
  //   chunk.remaining_credits < autoRechargeThreshold &&
  //   !chunk.is_extract
  // ) {
  //   logger.info("Auto-recharge triggered", {
  //     team_id,
  //     teamId: team_id,
  //     autoRechargeThreshold,
  //     remainingCredits: chunk.remaining_credits,
  //   });
  //
  //   const autoChargeResult = await autoCharge(chunk, autoRechargeThreshold);
  //
  //   if (autoChargeResult && autoChargeResult.success) {
  //     return {
  //       success: true,
  //       message: autoChargeResult.message,
  //       remainingCredits: allowOverages
  //         ? autoChargeResult.remainingCredits + chunk.price_credits
  //         : autoChargeResult.remainingCredits,
  //       chunk: autoChargeResult.chunk,
  //     };
  //   } else if (allowOverages) {
  //     return {
  //       success: true,
  //       message: "Auto-recharge failed, but price should be graceful",
  //       remainingCredits,
  //       chunk,
  //     };
  //   }
  // }

  // Compare the adjusted total credits used with the credits allowed by the plan (and graceful)
  if (!success) {
    logger.warn("Credit check failed - insufficient credits", {
      team_id,
      teamId: team_id,
      creditsRequested: credits,
      is_extract: chunk.is_extract,
      bypassCreditChecks: chunk.flags?.bypassCreditChecks,
      price_should_be_graceful: chunk.price_should_be_graceful,
      price_credits: chunk.price_credits,
      coupon_credits: chunk.coupon_credits,
      total_credits_sum: chunk.total_credits_sum,
      credits_used: chunk.credits_used,
      adjusted_credits_used: chunk.adjusted_credits_used,
      remaining_credits: chunk.remaining_credits,
      sub_current_period_start: chunk.sub_current_period_start,
      sub_current_period_end: chunk.sub_current_period_end,
      computed_remainingCredits: remainingCredits,
      computed_creditsWillBeUsed: creditsWillBeUsed,
      computed_totalPriceCredits: totalPriceCredits,
      creditUsagePercentage,
      sumComponents: chunk.price_credits + chunk.coupon_credits,
    });
    return {
      success: false,
      message:
        "Insufficient credits to perform this request. For more credits, you can upgrade your plan at https://firecrawl.dev/pricing.",
      remainingCredits,
      chunk,
    };
  }

  return {
    success: true,
    message: "Sufficient credits available",
    remainingCredits,
    chunk,
  };
}
