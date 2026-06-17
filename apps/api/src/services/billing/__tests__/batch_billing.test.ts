import { vi } from "vitest";

// vi.mock is hoisted above the file's static imports, so any value a factory
// reads at build time must be created in vi.hoisted(). (Jest left jest.mock
// un-hoisted here because `jest` was imported from @jest/globals.) The `redis`
// stub below stays module-level: its factory only captures it lazily.
const {
  captureException,
  addBreadcrumb,
  logger,
  withAuth,
  trackCredits,
  refundCredits,
  billTeam6,
  setCachedACUC,
  setCachedACUCTeam,
} = vi.hoisted(() => {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return {
    captureException: vi.fn(),
    addBreadcrumb: vi.fn(),
    logger,
    withAuth: vi.fn((fn: any) => fn),
    trackCredits: vi.fn<(args: any) => Promise<string | null>>(),
    refundCredits: vi.fn<(args: any) => Promise<void>>(),
    billTeam6: vi.fn<(params: any) => Promise<{ api_key: string; credits_applied?: number }[]>>(),
    setCachedACUC: vi.fn(),
    setCachedACUCTeam: vi.fn(),
  };
});

vi.mock("@sentry/node", () => ({
  captureException,
  addBreadcrumb,
}));

vi.mock("../../../lib/logger", () => ({
  logger,
}));

vi.mock("../../../lib/withAuth", () => ({
  withAuth,
}));

vi.mock("../../autumn/autumn.service", () => ({
  autumnService: {
    trackCredits,
    refundCredits,
  },
  featureIdForBillingEndpoint: (endpoint?: string) =>
    endpoint === "search" ? "SEARCH_CREDITS" : "CREDITS",
}));

vi.mock("../../../db/rpc", () => ({
  billTeam6,
}));

vi.mock("../../../controllers/auth", () => ({
  setCachedACUC,
  setCachedACUCTeam,
}));

let queue: string[] = [];
const billedTeams = new Set<string>();
const locks = new Map<string, string>();
const redis = {
  set: vi.fn(
    async (
      key: string,
      value: string,
      mode: string,
      timeout: number,
      nx: string,
    ) => {
      if (
        key !== "billing_batch_lock" ||
        value !== "1" ||
        mode !== "PX" ||
        timeout !== 30000 ||
        nx !== "NX"
      ) {
        throw new Error("unexpected redis.set args");
      }
      if (locks.has(key)) return null;
      locks.set(key, value);
      return "OK";
    },
  ),
  del: vi.fn(async (key: string) => {
    if (key !== "billing_batch_lock") {
      throw new Error("unexpected redis.del key");
    }
    return locks.delete(key) ? 1 : 0;
  }),
  lpop: vi.fn(async (key: string) => {
    if (key !== "billing_batch") {
      throw new Error("unexpected redis.lpop key");
    }
    return queue.shift() ?? null;
  }),
  llen: vi.fn(async (key: string) => {
    if (key !== "billing_batch") {
      throw new Error("unexpected redis.llen key");
    }
    return queue.length;
  }),
  rpush: vi.fn(async (key: string, value: string) => {
    if (key !== "billing_batch") {
      throw new Error("unexpected redis.rpush key");
    }
    queue.push(value);
    return queue.length;
  }),
  sadd: vi.fn(async (key: string, teamId: string) => {
    if (key !== "billed_teams") {
      throw new Error("unexpected redis.sadd key");
    }
    billedTeams.add(teamId);
    return 1;
  }),
};
vi.mock("../../queue-service", () => ({
  getRedisConnection: () => redis,
}));

import { processBillingBatch } from "../batch_billing";

function makeOp(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    team_id: "team-1",
    subscription_id: "sub-1",
    credits: 10,
    billing: { endpoint: "extract" },
    is_extract: false,
    timestamp: "2026-03-13T00:00:00.000Z",
    api_key_id: 123,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  queue = [];
  billedTeams.clear();
  locks.clear();
  billTeam6.mockResolvedValue([]);
  trackCredits.mockResolvedValue("batch-track-uuid");
  refundCredits.mockResolvedValue(undefined);
});

describe("processBillingBatch", () => {
  it("tracks queued Autumn usage when the request path did not", async () => {
    queue = [makeOp()];

    await processBillingBatch();

    expect(billTeam6).toHaveBeenCalled();
    expect(trackCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 10,
      properties: {
        source: "processBillingBatch",
        endpoint: "extract",
        apiKeyId: 123,
        subscriptionId: "sub-1",
      },
      featureId: "CREDITS",
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("skips Autumn tracking when the request path already tracked the op", async () => {
    queue = [makeOp({ autumnTrackInRequest: true })];

    await processBillingBatch();

    expect(billTeam6).toHaveBeenCalled();
    expect(trackCredits).not.toHaveBeenCalled();
  });

  it("continues when billing returns success false", async () => {
    queue = [makeOp({ autumnTrackInRequest: true, trackId: "op-track-1" })];
    billTeam6.mockRejectedValueOnce(new Error("db failed"));

    await processBillingBatch();

    expect(refundCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 10,
      properties: {
        source: "processBillingBatch",
        endpoint: "extract",
        apiKeyId: 123,
        subscriptionId: "sub-1",
      },
      featureId: "CREDITS",
      trackId: "op-track-1",
    });
    expect(captureException).toHaveBeenCalled();
  });

  it("captures exceptions when billing throws", async () => {
    queue = [makeOp({ autumnTrackInRequest: true, trackId: "op-track-2" })];
    billTeam6.mockRejectedValueOnce(new Error("rpc exploded"));

    await processBillingBatch();

    expect(refundCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 10,
      properties: {
        source: "processBillingBatch",
        endpoint: "extract",
        apiKeyId: 123,
        subscriptionId: "sub-1",
      },
      featureId: "CREDITS",
      trackId: "op-track-2",
    });
    expect(captureException).toHaveBeenCalled();
  });

  it("continues processing later groups when Autumn refund fails", async () => {
    queue = [
      makeOp({
        team_id: "team-1",
        subscription_id: "sub-1",
        autumnTrackInRequest: true,
        trackId: "op-track-3",
      }),
      makeOp({
        team_id: "team-2",
        subscription_id: "sub-2",
        autumnTrackInRequest: false,
      }),
    ];
    billTeam6
      .mockRejectedValueOnce(new Error("db failed"))
      .mockResolvedValueOnce([{ api_key: "", credits_applied: 10 }]);
    refundCredits.mockRejectedValueOnce(new Error("refund failed"));

    await processBillingBatch();

    expect(refundCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 10,
      properties: {
        source: "processBillingBatch",
        endpoint: "extract",
        apiKeyId: 123,
        subscriptionId: "sub-1",
      },
      featureId: "CREDITS",
      trackId: "op-track-3",
    });
    expect(billTeam6).toHaveBeenCalledTimes(2);
    expect(trackCredits).toHaveBeenCalledWith({
      teamId: "team-2",
      value: 10,
      properties: {
        source: "processBillingBatch",
        endpoint: "extract",
        apiKeyId: 123,
        subscriptionId: "sub-2",
      },
      featureId: "CREDITS",
    });
    expect(captureException).toHaveBeenCalled();
  });

  it("emits a Sentry breadcrumb + delta refund when Autumn tracked but DB applied less (FIRE-BILL-001)", async () => {
    // Autumn tracked the request for 10 credits (trackId "drift-track-1")
    // but the DB RPC only applied 4. The batch worker should detect the
    // divergence, refund the 6-credit delta, and surface a breadcrumb.
    queue = [
      makeOp({
        team_id: "drift-team",
        credits: 10,
        autumnTrackInRequest: true,
        trackId: "drift-track-1",
      }),
    ];
    billTeam6.mockResolvedValueOnce([
      { api_key: "", credits_applied: 4 },
    ]);

    await processBillingBatch();

    // Delta refund: 10 - 4 = 6 credits.
    expect(refundCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "drift-team",
        value: 6,
        featureId: "CREDITS",
        properties: expect.objectContaining({
          source: "divergence_reconcile",
        }),
      }),
    );

    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "billing",
        message: "Autumn/DB credit divergence",
        level: "warning",
        data: expect.objectContaining({
          team_id: "drift-team",
          op_count: 1,
          expected_tracked: 10,
          actual_applied: 4,
        }),
      }),
    );
  });

  it("does not refund or breadcrumb when Autumn tracked and DB applied the same amount", async () => {
    queue = [
      makeOp({
        team_id: "ok-team",
        credits: 7,
        autumnTrackInRequest: true,
        trackId: "ok-track-1",
      }),
    ];
    billTeam6.mockResolvedValueOnce([
      { api_key: "", credits_applied: 7 },
    ]);

    await processBillingBatch();

    expect(refundCredits).not.toHaveBeenCalled();
    expect(addBreadcrumb).not.toHaveBeenCalled();
  });

  it("falls back to total_credits when billTeam6 does not emit credits_applied (self-host default)", async () => {
    // Self-host SQL function doesn't return credits_applied — divergence
    // detection should treat requested == applied and not fire.
    queue = [
      makeOp({
        team_id: "self-host-team",
        credits: 5,
        autumnTrackInRequest: true,
        trackId: "self-host-track-1",
      }),
    ];
    billTeam6.mockResolvedValueOnce([{ api_key: "" }]);

    await processBillingBatch();

    expect(refundCredits).not.toHaveBeenCalled();
    expect(addBreadcrumb).not.toHaveBeenCalled();
  });
});
