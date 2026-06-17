import { vi } from "vitest";

// vi.mock is hoisted; factory-referenced values must be created in vi.hoisted().
// (Jest didn't hoist jest.mock here because `jest` was imported from @jest/globals.)
const {
  withAuth,
  queueBillingOperation,
  trackCredits,
  refundCredits,
  addBreadcrumb,
} = vi.hoisted(() => ({
  withAuth: vi.fn((fn: any) => fn),
  queueBillingOperation: vi.fn<(args: any[]) => Promise<any>>(),
  // FIRE-BILL-001: trackCredits now returns the trackId uuid (string | null)
  trackCredits: vi.fn<(args: any) => Promise<string | null>>(),
  refundCredits: vi.fn<(args: any) => Promise<void>>(),
  addBreadcrumb: vi.fn(),
}));

vi.mock("../../../lib/withAuth", () => ({
  withAuth,
}));

vi.mock("../batch_billing", () => ({
  queueBillingOperation: (...args: any[]) => queueBillingOperation(args),
}));

vi.mock("../../autumn/autumn.service", () => ({
  autumnService: {
    trackCredits,
    refundCredits,
  },
  featureIdForBillingEndpoint: (endpoint?: string) =>
    endpoint === "search" ? "SEARCH_CREDITS" : "CREDITS",
}));

vi.mock("@sentry/node", () => ({
  addBreadcrumb,
}));

vi.mock("../../notification/email_notification", () => ({
  sendNotification: vi.fn(),
}));
vi.mock("../auto_charge", () => ({
  autoCharge: vi.fn(),
}));
vi.mock("../../redis", () => ({
  getValue: vi.fn(),
  setValue: vi.fn(),
}));
vi.mock("../../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { billTeam } from "../credit_billing";

beforeEach(() => {
  vi.clearAllMocks();
  queueBillingOperation.mockResolvedValue({ success: true });
  trackCredits.mockResolvedValue("track-uuid-1");
  refundCredits.mockResolvedValue(undefined);
});

describe("billTeam", () => {
  it("marks billing as already tracked when request tracking succeeds and threads the trackId", async () => {
    const result = await billTeam("team-1", "sub-1", 3, 123, {
      endpoint: "search",
      jobId: "job-1",
    });

    expect(queueBillingOperation).toHaveBeenCalledWith([
      "team-1",
      "sub-1",
      3,
      123,
      { endpoint: "search", jobId: "job-1" },
      false,
      true,
      "track-uuid-1",
    ]);
    expect(trackCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 3,
      properties: {
        source: "billTeam",
        endpoint: "search",
        jobId: "job-1",
        apiKeyId: 123,
      },
      requestScoped: true,
    });
    expect(result).toMatchObject({
      success: true,
      trackId: "track-uuid-1",
    });
  });

  it("refunds Autumn with the original trackId when queueing fails after request tracking", async () => {
    queueBillingOperation.mockResolvedValueOnce({ success: false });

    const result = await billTeam("team-1", "sub-1", 3, 123, {
      endpoint: "search",
      jobId: "job-1",
    });

    expect(refundCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 3,
      properties: {
        source: "billTeam",
        endpoint: "search",
        jobId: "job-1",
        apiKeyId: 123,
      },
      trackId: "track-uuid-1",
    });
    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "billing",
        message: "billTeam queue failure after Autumn track",
        data: expect.objectContaining({ team_id: "team-1", trackId: "track-uuid-1" }),
      }),
    );
    expect(result.success).toBe(false);
  });

  it("leaves batch tracking enabled when request tracking is off", async () => {
    trackCredits.mockResolvedValueOnce(null);

    const result = await billTeam("team-1", "sub-1", 3, 123, {
      endpoint: "search",
      jobId: "job-1",
    });

    expect(queueBillingOperation).toHaveBeenCalledWith([
      "team-1",
      "sub-1",
      3,
      123,
      { endpoint: "search", jobId: "job-1" },
      false,
      false,
      undefined,
    ]);
    expect(refundCredits).not.toHaveBeenCalled();
    // FIRE-BILL-001: when Autumn track is skipped but DB bill succeeds, the
    // billTeam caller is silently under-counted in Autumn. Mark divergent.
    expect(result.divergent).toBe(true);
    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "billing",
        message: "Autumn track skipped while DB bill succeeded",
      }),
    );
  });
});
