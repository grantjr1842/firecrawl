import { supabase_rr_service } from "../../../services/supabase";
import { EndpointFeedbackEndpoint } from "../types";
import { FeedbackLogger } from "./internal-types";

function startOfUtcDay(now: Date = new Date()): Date {
  const start = new Date(now.getTime());
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

export async function sumCreditsRefundedToday(
  dbTeamId: string,
  endpoint: EndpointFeedbackEndpoint,
  logger: FeedbackLogger,
  opts: { includeLegacySearch?: boolean } = {},
): Promise<number> {
  const since = startOfUtcDay().toISOString();
  const { data, error } = await supabase_rr_service
    .from("endpoint_feedback")
    .select("credits_refunded")
    .eq("team_id", dbTeamId)
    .gte("created_at", since);

  if (error) {
    logger.warn(
      "Failed to compute endpoint feedback refund total; allowing refund this call",
      { error },
    );
    return 0;
  }

  const endpointTotal = (data ?? []).reduce(
    (sum, row: { credits_refunded: number | null }) =>
      sum + (row.credits_refunded ?? 0),
    0,
  );

  if (endpoint !== "search" || opts.includeLegacySearch !== true) {
    return endpointTotal;
  }

  const { data: legacyData, error: legacyError } = await supabase_rr_service
    .from("search_feedback")
    .select("credits_refunded")
    .eq("team_id", dbTeamId)
    .gte("created_at", since);

  if (legacyError) {
    logger.warn("Failed to compute legacy search feedback refund total", {
      error: legacyError,
    });
    return endpointTotal;
  }

  const legacyTotal = (legacyData ?? []).reduce(
    (sum, row: { credits_refunded: number | null }) =>
      sum + (row.credits_refunded ?? 0),
    0,
  );

  // Search feedback is mirrored into the old table during migration. Taking
  // the max preserves old rows without double-counting mirrored new rows.
  return Math.max(endpointTotal, legacyTotal);
}
