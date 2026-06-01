import { Response } from "express";
import { z } from "zod";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import {
  isPostgrestNoRowsError,
  supabase_rr_service,
  supabase_service,
} from "../../services/supabase";
import {
  RequestWithAuth,
  SearchFeedbackRequest,
  SearchFeedbackResponse,
  searchFeedbackSchema,
} from "./types";
import {
  normalizeFeedbackTeamId,
  recordEndpointFeedback,
} from "./feedback/record";
import { sumCreditsRefundedToday } from "./feedback/refund-totals";
import { toSearchFeedbackInput } from "./feedback/request-input";

const POSTGRES_UNIQUE_VIOLATION = "23505";

function isPreviewTeam(teamId: string): boolean {
  return teamId === "preview" || teamId.startsWith("preview_");
}

async function findExistingSearchFeedback(
  searchId: string,
  dbTeamId: string,
): Promise<{ id: string; credits_refunded: number | null } | null> {
  const { data, error } = await supabase_rr_service
    .from("search_feedback")
    .select("id, credits_refunded")
    .eq("search_id", searchId)
    .eq("team_id", dbTeamId)
    .single();

  if (error) {
    if (isPostgrestNoRowsError(error)) return null;
    throw error;
  }

  return data as { id: string; credits_refunded: number | null } | null;
}

async function mirrorSearchFeedback(
  feedbackId: string,
  searchId: string,
  dbTeamId: string,
  feedback: SearchFeedbackRequest,
  creditsRefunded: number,
  logger: ReturnType<typeof _logger.child>,
) {
  const row = {
    id: feedbackId,
    search_id: searchId,
    team_id: dbTeamId,
    overall_rating: feedback.rating,
    valuable_sources: feedback.valuableSources ?? [],
    missing_content: feedback.missingContent ?? [],
    query_suggestions: feedback.querySuggestions ?? null,
    integration: feedback.integration ?? null,
    origin: feedback.origin ?? null,
    credits_refunded: creditsRefunded,
  };

  const { error } = await supabase_service.from("search_feedback").insert(row);
  if (!error) return;

  if ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
    const { error: updateErr } = await supabase_service
      .from("search_feedback")
      .update({ credits_refunded: creditsRefunded })
      .eq("search_id", searchId)
      .eq("team_id", dbTeamId);

    if (updateErr) {
      logger.warn("Failed to update mirrored search_feedback row", {
        error: updateErr,
        feedbackId,
        searchId,
      });
    }
    return;
  }

  logger.warn("Failed to mirror endpoint feedback into search_feedback", {
    error,
    feedbackId,
    searchId,
  });
}

export async function searchFeedbackController(
  req: RequestWithAuth<
    { jobId: string },
    SearchFeedbackResponse,
    SearchFeedbackRequest
  >,
  res: Response<SearchFeedbackResponse>,
) {
  const searchId = req.params.jobId;
  const logger = _logger.child({
    module: "api/v2",
    method: "searchFeedbackController",
    searchId,
    teamId: req.auth.team_id,
  });

  let parsedBody: SearchFeedbackRequest;
  try {
    parsedBody = searchFeedbackSchema.parse(req.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn("Invalid feedback body", { error: error.issues });
      return res.status(400).json({
        success: false,
        error: "Invalid request body",
        details: error.issues,
        feedbackErrorCode: "INVALID_BODY",
      });
    }
    throw error;
  }

  const dbTeamId = normalizeFeedbackTeamId(req.auth.team_id);
  if (
    config.USE_DB_AUTHENTICATION === true &&
    !isPreviewTeam(req.auth.team_id) &&
    req.acuc?.flags?.searchFeedbackOptOut !== true
  ) {
    try {
      const existing = await findExistingSearchFeedback(searchId, dbTeamId);
      if (existing) {
        const creditsRefundedToday = await sumCreditsRefundedToday(
          dbTeamId,
          "search",
          logger,
          { includeLegacySearch: true },
        );

        return res.status(200).json({
          success: true,
          feedbackId: existing.id,
          creditsRefunded: 0,
          alreadySubmitted: true,
          creditsRefundedToday,
          dailyRefundCap: config.SEARCH_FEEDBACK_DAILY_CAP_CREDITS,
          warning:
            "Feedback was already submitted for this search; no additional refund issued.",
        });
      }
    } catch (error) {
      logger.error("Failed to look up legacy search feedback", { error });
      return res.status(500).json({
        success: false,
        error: "Failed to look up search feedback.",
        feedbackErrorCode: "INTERNAL",
      });
    }
  }

  const result = await recordEndpointFeedback(req, {
    endpoint: "search",
    jobId: searchId,
    feedback: toSearchFeedbackInput(parsedBody),
    requireSuccessfulJob: true,
    notFoundCode: "SEARCH_NOT_FOUND",
    failedJobCode: "SEARCH_FAILED",
    dbDisabledMessage:
      "Search feedback requires database authentication and is unavailable on this deployment.",
    windowExpiredMessage: `Search feedback must be submitted within ${config.SEARCH_FEEDBACK_MAX_AGE_SEC} seconds of the search.`,
    maxAgeSec: config.SEARCH_FEEDBACK_MAX_AGE_SEC,
    dailyCapCredits: config.SEARCH_FEEDBACK_DAILY_CAP_CREDITS,
    source: "search_feedback",
  });

  if (
    result.status === 200 &&
    result.body.success === true &&
    result.body.alreadySubmitted !== true
  ) {
    await mirrorSearchFeedback(
      result.body.feedbackId,
      searchId,
      dbTeamId,
      parsedBody,
      result.body.creditsRefunded,
      logger,
    );
  }

  return res.status(result.status).json(result.body);
}
