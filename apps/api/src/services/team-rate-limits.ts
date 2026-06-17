// Per-team rate-limit tier resolution.
//
// The API exposes three rate-limit tiers keyed off a team record:
//   - "free"       — anonymous / unauthenticated trial.
//   - "standard"   — paying self-serve customers.
//   - "scale"      — enterprise contracts with custom QPS caps.
//
// The contract tested here is:
//
//   resolveTeamTier(input) → tier
//
// where `input` is one of:
//
//   { kind: "anon" }                          → "free"
//   { kind: "by-id", teamId }                 → tier looked up by id
//   { kind: "by-plan", plan }                 → tier looked up by plan
//
// The lookup-by-id path is async because the production caller hits
// a control-plane DB; the lookup-by-plan path is sync (the plan name
// is on the API key at request time). The co-located test file
// `team-rate-limits.test.ts` exercises both paths plus the anon path.

export type TeamTier = "free" | "standard" | "scale";

export type ResolveTeamTierInput =
  | { kind: "anon" }
  | { kind: "by-id"; teamId: string }
  | { kind: "by-plan"; plan: string };

export type TeamRecord = {
  teamId: string;
  plan: string | null;
  isActive: boolean;
};

const PLAN_TO_TIER: Record<string, TeamTier> = {
  free: "free",
  hobby: "free",
  standard: "standard",
  growth: "standard",
  pro: "standard",
  scale: "scale",
  enterprise: "scale",
};

/**
 * Map a plan name (the human-readable string, e.g. "free", "growth",
 * "scale") to a rate-limit tier bucket.
 *
 * This intentionally does NOT take a `price_id` (the Stripe price
 * identifier) — those are opaque and change on every new billing
 * contract. Callers that have a `price_id` must look up the
 * associated plan name first; the AuthCreditUsageChunk `plan` field
 * is the SQL-threaded plan name.
 *
 * The function is case-insensitive and falls through to `"free"` for
 * unknown / null / undefined input. The "free" default is the
 * safest tier — the operator can still bump a tenant via env-driven
 * overrides — and a misconfigured control plane that emits an
 * unknown plan string must NEVER 500 the hot path.
 */
export function tierFromPlan(plan: string | null | undefined): TeamTier {
  if (!plan) return "free";
  return PLAN_TO_TIER[plan.toLowerCase()] ?? "free";
}

/**
 * Resolve a team's tier from a minimal record. Pure function; safe to
 * call inside hot middleware paths.
 *
 * - Inactive teams are bucketed as "free" — the billing system has
 *   cut them off and the operator-facing limiter will 403 them.
 * - The plan lookup is case-insensitive and falls through to "free"
 *   for unknown plan strings (rather than throwing) so a misconfigured
 *   control-plane never produces a 500 on the hot path.
 */
export function tierFromTeamRecord(team: TeamRecord): TeamTier {
  if (!team.isActive) return "free";
  return tierFromPlan(team.plan);
}

/**
 * Async tier resolver used by the middleware that needs to look a
 * team up by id. The default implementation reads from the
 * `team-store` module; tests inject a custom lookup via the
 * `_setTeamLookupForTest` hook.
 */
export type TeamLookup = (teamId: string) => Promise<TeamRecord | null>;

let _teamLookup: TeamLookup | null = null;

export function _setTeamLookupForTest(fn: TeamLookup | null): void {
  _teamLookup = fn;
}

export async function resolveTeamTier(
  input: ResolveTeamTierInput,
): Promise<TeamTier> {
  if (input.kind === "anon") return "free";
  if (input.kind === "by-plan") return tierFromPlan(input.plan);
  // input.kind === "by-id"
  if (!_teamLookup) {
    // No team-store registered (e.g. self-hosted with no control
    // plane). Default to "free" — the safest tier, the operator
    // can still bump via env-driven override.
    return "free";
  }
  const team = await _teamLookup(input.teamId);
  if (!team) return "free";
  return tierFromTeamRecord(team);
}

/**
 * Per-tier concurrent-request caps. The middleware reads this map to
 * decide whether to admit a new request or queue it. Numbers are
 * conservative defaults; operators override via env in the
 * deployment chart.
 */
export const TIER_CONCURRENT_REQUESTS: Record<TeamTier, number> = {
  free: 5,
  standard: 50,
  scale: 500,
};

export function concurrentRequestCap(tier: TeamTier): number {
  return TIER_CONCURRENT_REQUESTS[tier];
}
