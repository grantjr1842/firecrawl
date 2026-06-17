import {
  resolveTeamTier,
  tierFromPlan,
  tierFromTeamRecord,
  concurrentRequestCap,
  TIER_CONCURRENT_REQUESTS,
  _setTeamLookupForTest,
  type TeamRecord,
  type TeamTier,
} from "./team-rate-limits";

beforeEach(() => {
  _setTeamLookupForTest(null);
});

describe("tierFromPlan", () => {
  it("maps known plans to their tier bucket", () => {
    expect(tierFromPlan("free")).toBe("free");
    expect(tierFromPlan("hobby")).toBe("free");
    expect(tierFromPlan("standard")).toBe("standard");
    expect(tierFromPlan("growth")).toBe("standard");
    expect(tierFromPlan("pro")).toBe("standard");
    expect(tierFromPlan("scale")).toBe("scale");
    expect(tierFromPlan("enterprise")).toBe("scale");
  });

  it("is case-insensitive on the plan string", () => {
    expect(tierFromPlan("FREE")).toBe("free");
    expect(tierFromPlan("Standard")).toBe("standard");
    expect(tierFromPlan("ENTERPRISE")).toBe("scale");
  });

  it("falls through to 'free' for unknown plan strings", () => {
    // A misconfigured control plane that emits an unknown plan name
    // must NOT 500 the hot path. Defaulting to the lowest tier is
    // safe because the operator can manually override via env.
    expect(tierFromPlan("nonsense")).toBe("free");
    expect(tierFromPlan("")).toBe("free");
  });

  it("treats null / undefined plan as 'free'", () => {
    expect(tierFromPlan(null)).toBe("free");
    expect(tierFromPlan(undefined)).toBe("free");
  });

  it("does NOT interpret Stripe price_ids as plan names", () => {
    // Regression guard for the historical bug: callers used to pass
    // `chunk.price_id` (the opaque Stripe price identifier) into the
    // tier resolver. Stripe price_ids look like "price_1ABCxyz..." and
    // are NOT plan names. Every such value must bucket to "free" so
    // the tierFromPlan contract stays "input is a plan name, not a
    // price_id".
    expect(tierFromPlan("price_1ABCdefGHIjklMNOpqrsTUV")).toBe("free");
    expect(tierFromPlan("price_1234567890")).toBe("free");
  });
});

describe("tierFromTeamRecord", () => {
  it("inactive teams are bucketed as 'free'", () => {
    const record: TeamRecord = {
      teamId: "team-1",
      plan: "enterprise",
      isActive: false,
    };
    expect(tierFromTeamRecord(record)).toBe("free");
  });

  it("active teams follow their plan tier", () => {
    expect(
      tierFromTeamRecord({ teamId: "t", plan: "free", isActive: true }),
    ).toBe("free");
    expect(
      tierFromTeamRecord({ teamId: "t", plan: "growth", isActive: true }),
    ).toBe("standard");
    expect(
      tierFromTeamRecord({ teamId: "t", plan: "scale", isActive: true }),
    ).toBe("scale");
  });

  it("an active team with no plan defaults to 'free'", () => {
    expect(
      tierFromTeamRecord({ teamId: "t", plan: null, isActive: true }),
    ).toBe("free");
  });
});

describe("resolveTeamTier (async, by-id)", () => {
  it("returns 'free' when no team store is registered", async () => {
    const tier = await resolveTeamTier({ kind: "by-id", teamId: "team-1" });
    expect(tier).toBe("free");
  });

  it("delegates to the registered team lookup and maps the result", async () => {
    const lookup = vi.fn(
      async (teamId: string): Promise<TeamRecord | null> => {
        if (teamId === "team-active") {
          return { teamId, plan: "growth", isActive: true };
        }
        if (teamId === "team-cutoff") {
          return { teamId, plan: "enterprise", isActive: false };
        }
        return null;
      },
    );
    _setTeamLookupForTest(lookup);

    await expect(
      resolveTeamTier({ kind: "by-id", teamId: "team-active" }),
    ).resolves.toBe("standard");
    await expect(
      resolveTeamTier({ kind: "by-id", teamId: "team-cutoff" }),
    ).resolves.toBe("free");
    await expect(
      resolveTeamTier({ kind: "by-id", teamId: "team-unknown" }),
    ).resolves.toBe("free");

    expect(lookup).toHaveBeenCalledWith("team-active");
    expect(lookup).toHaveBeenCalledWith("team-cutoff");
  });
});

describe("resolveTeamTier (sync paths)", () => {
  it("returns 'free' for the anon path", async () => {
    await expect(resolveTeamTier({ kind: "anon" })).resolves.toBe("free");
  });

  it("returns the plan-derived tier for the by-plan path", async () => {
    await expect(
      resolveTeamTier({ kind: "by-plan", plan: "enterprise" }),
    ).resolves.toBe("scale");
    await expect(
      resolveTeamTier({ kind: "by-plan", plan: "growth" }),
    ).resolves.toBe("standard");
    await expect(
      resolveTeamTier({ kind: "by-plan", plan: "free" }),
    ).resolves.toBe("free");
    await expect(
      resolveTeamTier({ kind: "by-plan", plan: "" }),
    ).resolves.toBe("free");
  });
});

describe("concurrentRequestCap", () => {
  it("returns the configured cap for every known tier", () => {
    expect(concurrentRequestCap("free")).toBe(TIER_CONCURRENT_REQUESTS.free);
    expect(concurrentRequestCap("standard")).toBe(
      TIER_CONCURRENT_REQUESTS.standard,
    );
    expect(concurrentRequestCap("scale")).toBe(TIER_CONCURRENT_REQUESTS.scale);
  });

  it("caps grow monotonically from free -> standard -> scale", () => {
    const tiers: TeamTier[] = ["free", "standard", "scale"];
    for (let i = 1; i < tiers.length; i++) {
      expect(concurrentRequestCap(tiers[i])).toBeGreaterThan(
        concurrentRequestCap(tiers[i - 1]),
      );
    }
  });
});
