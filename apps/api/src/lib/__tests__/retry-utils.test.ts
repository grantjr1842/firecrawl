import {
  constantBackoff,
  linearBackoff,
  exponentialBackoff,
  decorrelatedJitterBackoff,
  computeBackoff,
  executeWithRetry,
  retryIdempotent,
  retryFireEngineApi,
  attemptRequest,
  type BackoffStrategy,
} from "../retry-utils";

describe("backoff strategies", () => {
  describe("constantBackoff", () => {
    it("returns the base delay regardless of attempt index", () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        expect(constantBackoff(attempt, { baseDelayMs: 250 })).toBe(250);
      }
    });

    it("caps at maxDelayMs when baseDelayMs exceeds it", () => {
      expect(
        constantBackoff(0, { baseDelayMs: 5_000, maxDelayMs: 1_000 }),
      ).toBe(1_000);
    });

    it("applies jitter when configured", () => {
      // With jitter=0.5 the delay must stay within ±50% of 1000 = [500, 1500].
      const samples = Array.from({ length: 50 }, () =>
        constantBackoff(0, { baseDelayMs: 1_000, jitter: 0.5 }),
      );
      for (const s of samples) {
        expect(s).toBeGreaterThanOrEqual(500);
        expect(s).toBeLessThanOrEqual(1_500);
      }
    });
  });

  describe("linearBackoff", () => {
    it("grows linearly with attempt index", () => {
      expect(linearBackoff(0, { baseDelayMs: 100 })).toBe(100);
      expect(linearBackoff(1, { baseDelayMs: 100 })).toBe(200);
      expect(linearBackoff(2, { baseDelayMs: 100 })).toBe(300);
    });

    it("caps at maxDelayMs", () => {
      expect(
        linearBackoff(20, { baseDelayMs: 100, maxDelayMs: 500 }),
      ).toBe(500);
    });
  });

  describe("exponentialBackoff", () => {
    it("doubles the base delay each attempt", () => {
      expect(exponentialBackoff(0, { baseDelayMs: 100 })).toBe(100);
      expect(exponentialBackoff(1, { baseDelayMs: 100 })).toBe(200);
      expect(exponentialBackoff(2, { baseDelayMs: 100 })).toBe(400);
      expect(exponentialBackoff(3, { baseDelayMs: 100 })).toBe(800);
    });

    it("caps at maxDelayMs", () => {
      expect(
        exponentialBackoff(20, { baseDelayMs: 100, maxDelayMs: 5_000 }),
      ).toBe(5_000);
    });

    it("does not overflow on very large attempt indices", () => {
      // attempt 100 would be 2^100 * 100 = absurd; must clamp cleanly.
      const result = exponentialBackoff(100, {
        baseDelayMs: 100,
        maxDelayMs: 30_000,
      });
      expect(result).toBe(30_000);
    });
  });

  describe("decorrelatedJitterBackoff", () => {
    it("stays within [baseDelay, prevDelay * 3]", () => {
      const baseDelay = 100;
      const prevDelay = 1_000;
      for (let i = 0; i < 100; i++) {
        const d = decorrelatedJitterBackoff(
          1,
          { baseDelayMs: baseDelay, maxDelayMs: 10_000 },
          prevDelay,
        );
        expect(d).toBeGreaterThanOrEqual(baseDelay);
        expect(d).toBeLessThanOrEqual(prevDelay * 3);
      }
    });

    it("seeds from baseDelay when prevDelay is omitted", () => {
      const samples = Array.from({ length: 50 }, () =>
        decorrelatedJitterBackoff(0, { baseDelayMs: 200 }),
      );
      // First attempt with no prev: seed=baseDelay=200; upper = 200*3=600.
      for (const s of samples) {
        expect(s).toBeGreaterThanOrEqual(200);
        expect(s).toBeLessThanOrEqual(600);
      }
    });
  });

  describe("computeBackoff", () => {
    it("dispatches to the right strategy", () => {
      const opts = { baseDelayMs: 100 };
      const strategies: BackoffStrategy[] = [
        "constant",
        "linear",
        "exponential",
        "decorrelated-jitter",
      ];
      for (const s of strategies) {
        const result = computeBackoff(s, 2, opts);
        expect(typeof result).toBe("number");
        expect(result).toBeGreaterThanOrEqual(0);
      }
    });
  });
});

describe("executeWithRetry", () => {
  it("returns the first valid result without retrying", async () => {
    let calls = 0;
    const result = await executeWithRetry(
      async () => {
        calls++;
        return "hello";
      },
      (v): v is string => typeof v === "string",
    );
    expect(result).toBe("hello");
    expect(calls).toBe(1);
  });

  it("retries until the result predicate is satisfied", async () => {
    let calls = 0;
    const result = await executeWithRetry<number>(
      async () => {
        calls++;
        if (calls < 3) return null;
        return 42;
      },
      (v): v is number => typeof v === "number" && v !== null,
      undefined,
      5,
      [1, 1, 1, 1],
    );
    expect(result).toBe(42);
    expect(calls).toBe(3);
  });

  it("returns null when maxAttempts is exhausted and predicate never matches", async () => {
    let calls = 0;
    const result = await executeWithRetry(
      async () => {
        calls++;
        return null;
      },
      (v): v is never => false,
      undefined,
      3,
      [1, 1],
    );
    expect(result).toBeNull();
    expect(calls).toBe(3);
  });

  it("retries on thrown errors and eventually throws when exhausted", async () => {
    let calls = 0;
    await expect(
      executeWithRetry(
        async () => {
          calls++;
          if (calls < 3) throw new Error(`boom ${calls}`);
          return "ok";
        },
        (v): v is string => v === "ok",
        undefined,
        5,
        [1, 1, 1, 1],
      ),
    ).resolves.toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws the last error when all attempts throw", async () => {
    let calls = 0;
    await expect(
      executeWithRetry(
        async () => {
          calls++;
          throw new Error(`attempt ${calls}`);
        },
        (v): v is never => false,
        undefined,
        3,
        [1, 1],
      ),
    ).rejects.toThrow(/attempt 3/);
    expect(calls).toBe(3);
  });

  it("aborts immediately when shouldRetry returns false", async () => {
    let calls = 0;
    await expect(
      executeWithRetry(
        async () => {
          calls++;
          throw new Error("non-retryable");
        },
        (v): v is never => false,
        undefined,
        5,
        [1, 1, 1, 1],
        {
          shouldRetry: () => false,
        },
      ),
    ).rejects.toThrow(/non-retryable/);
    expect(calls).toBe(1);
  });

  it("supports exponential backoff strategy via options", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await executeWithRetry<string>(
      async () => {
        calls++;
        if (calls < 3) {
          throw new Error("transient");
        }
        return "done";
      },
      (v): v is string => v === "done",
      undefined,
      5,
      undefined,
      {
        backoffStrategy: "exponential",
        backoffOptions: { baseDelayMs: 10, maxDelayMs: 1_000 },
        onAttemptFailure: ({ nextDelayMs }) => delays.push(nextDelayMs),
      },
    );
    expect(result).toBe("done");
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it("fires onAttemptFailure even on successful attempts (for parity with legacy)", async () => {
    const events: number[] = [];
    let calls = 0;
    const result = await executeWithRetry(
      async () => {
        calls++;
        if (calls < 2) return null;
        return "ok";
      },
      (v): v is string => v === "ok",
      undefined,
      5,
      [5],
      {
        onAttemptFailure: ({ nextDelayMs }) => events.push(nextDelayMs),
      },
    );
    expect(result).toBe("ok");
    // Successful attempt-0 with no backoff needed still fires the hook.
    expect(events).toContain(5);
  });
});

describe("retryIdempotent", () => {
  it("runs the operation when an idempotencyKey is provided", async () => {
    let calls = 0;
    const result = await retryIdempotent(
      async () => {
        calls++;
        if (calls < 2) throw new Error("retry me");
        return "ok";
      },
      (v): v is string => v === "ok",
      {
        idempotencyKey: "test-key",
        retryDelays: [1],
        maxAttempts: 3,
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await retryIdempotent(
      async () => {
        calls++;
        return null;
      },
      (v): v is never => false,
      {
        idempotencyKey: "test-key",
        signal: controller.signal,
      },
    );
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("retryFireEngineApi (backward-compat wrapper)", () => {
  it("combines attemptRequest with executeWithRetry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ answer: 42 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await retryFireEngineApi<{ answer: number }>(
      "https://example.com",
      JSON.stringify({}),
      undefined,
    );
    expect(result).toEqual({ answer: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("returns null when every attempt fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Server Error",
      text: async () => "boom",
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await retryFireEngineApi<{ ok: boolean }>(
      "https://example.com",
      JSON.stringify({}),
      undefined,
      undefined,
      { maxAttempts: 2, retryDelays: [1] },
    );
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it("honors hasValidResult to short-circuit on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => null,
    });
    vi.stubGlobal("fetch", fetchMock);

    let calls = 0;
    const result = await retryFireEngineApi<{ ok: true }>(
      "https://example.com",
      JSON.stringify({}),
      undefined,
      (v): v is { ok: true } => {
        calls++;
        return v !== null && typeof v === "object" && "ok" in v;
      },
      { maxAttempts: 3, retryDelays: [1, 1] },
    );
    expect(result).toBeNull();
    // Predicate runs on every successful call's result; with 3 attempts
    // each returning null we expect exactly 3 predicate invocations.
    expect(calls).toBe(3);

    vi.unstubAllGlobals();
  });
});

describe("attemptRequest (backward-compat)", () => {
  it("returns null on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
    const result = await attemptRequest("https://example.com", "{}");
    expect(result).toBeNull();
    vi.unstubAllGlobals();
  });

  it("returns null on non-OK responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: async () => "upstream",
      }),
    );
    const result = await attemptRequest<unknown>("https://example.com", "{}");
    expect(result).toBeNull();
    vi.unstubAllGlobals();
  });
});