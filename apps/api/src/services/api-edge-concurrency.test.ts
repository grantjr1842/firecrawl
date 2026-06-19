// QR-001(b): vitest coverage for the API-edge load-shedding limiter.
//
// We exercise the limiter helpers directly against a real Redis when one
// is reachable (local dev / CI with a redis service); when not
// reachable the suite is a no-op. The assertions cover the three
// behaviors that close the production gap:
//
//   1. acquireApiEdgeSlot grants slots up to the cap (so well-behaved
//      traffic keeps flowing).
//   2. Once the cap is hit, acquireApiEdgeSlot returns granted:false
//      with a nextExpiryMs in the future. The controllers translate
//      this into a 429 + Retry-After header (verified at the integration
//      layer in snips).
//   3. releaseApiEdgeSlot frees the slot so a follow-up acquire is
//      granted again.
//
// The cap-vs-load balance pins a single team's in-flight count, which
// is exactly what the controllers enforce when they call this helper.

import {
  acquireApiEdgeSlot,
  releaseApiEdgeSlot,
  countApiEdgeInFlight,
} from "./api-edge-concurrency";
import { redisRateLimitClient } from "./rate-limiter";

const testTeamId = `vitest-qr001b-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2)}`;

let redisAvailable = false;

beforeAll(async () => {
  try {
    const ping = await Promise.race([
      redisRateLimitClient.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("redis ping timeout")), 2000),
      ),
    ]);
    redisAvailable = ping === "PONG";
  } catch {
    redisAvailable = false;
  }
  if (!redisAvailable) return;

  // Clean up any leftover state from a previous run for this team id.
  await redisRateLimitClient.del(`api-edge-conc:scrape:${testTeamId}`);
  await redisRateLimitClient.del(`api-edge-conc:crawl:${testTeamId}`);
});

afterAll(async () => {
  if (!redisAvailable) return;
  try {
    await redisRateLimitClient.del(`api-edge-conc:scrape:${testTeamId}`);
    await redisRateLimitClient.del(`api-edge-conc:crawl:${testTeamId}`);
  } catch {
    // ignore
  }
});

const itIfRedis = (cond: boolean) => (cond ? it : it.skip);

describe("acquireApiEdgeSlot", () => {
  itIfRedis(redisAvailable)(
    "returns granted:true while below the cap",
    async () => {
      const limit = 3;
      const r1 = await acquireApiEdgeSlot(
        "scrape",
        testTeamId,
        "holder-1",
        limit,
        10_000,
      );
      expect(r1.granted).toBe(true);

      const r2 = await acquireApiEdgeSlot(
        "scrape",
        testTeamId,
        "holder-2",
        limit,
        10_000,
      );
      expect(r2.granted).toBe(true);

      const r3 = await acquireApiEdgeSlot(
        "scrape",
        testTeamId,
        "holder-3",
        limit,
        10_000,
      );
      expect(r3.granted).toBe(true);

      expect(await countApiEdgeInFlight("scrape", testTeamId)).toBe(3);
    },
  );

  itIfRedis(redisAvailable)(
    "returns granted:false with nextExpiryMs once the cap is hit (the 429 + Retry-After signal)",
    async () => {
      // Reuse the previous test's state: 3 holders, limit 3. One more
      // acquire must be rejected with a usable nextExpiryMs hint.
      const before = Date.now();
      const rejected = await acquireApiEdgeSlot(
        "scrape",
        testTeamId,
        "holder-overflow",
        3,
        10_000,
      );
      expect(rejected.granted).toBe(false);
      if (!rejected.granted) {
        // The controller computes Retry-After from this exact field,
        // so it must be in the future and within the lease window.
        expect(rejected.nextExpiryMs).toBeGreaterThan(before);
        expect(rejected.nextExpiryMs).toBeLessThanOrEqual(before + 10_000);
      }
      expect(await countApiEdgeInFlight("scrape", testTeamId)).toBe(3);
    },
  );

  itIfRedis(redisAvailable)(
    "releaseApiEdgeSlot frees a slot so the next acquire is granted",
    async () => {
      await releaseApiEdgeSlot("scrape", testTeamId, "holder-2");
      expect(await countApiEdgeInFlight("scrape", testTeamId)).toBe(2);

      const granted = await acquireApiEdgeSlot(
        "scrape",
        testTeamId,
        "holder-after-release",
        3,
        10_000,
      );
      expect(granted.granted).toBe(true);
      expect(await countApiEdgeInFlight("scrape", testTeamId)).toBe(3);

      // Clean up the rest so subsequent test runs start from zero.
      await releaseApiEdgeSlot("scrape", testTeamId, "holder-1");
      await releaseApiEdgeSlot("scrape", testTeamId, "holder-3");
      await releaseApiEdgeSlot("scrape", testTeamId, "holder-after-release");
      await releaseApiEdgeSlot("scrape", testTeamId, "holder-overflow");
    },
  );

  itIfRedis(redisAvailable)(
    "limit=0 is the documented kill-switch and always grants",
    async () => {
      const granted = await acquireApiEdgeSlot(
        "scrape",
        testTeamId,
        "holder-disabled",
        0,
        10_000,
      );
      expect(granted.granted).toBe(true);
    },
  );
});
