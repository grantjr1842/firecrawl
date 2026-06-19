import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerTimeoutError,
  createCircuitBreaker,
  getCircuitBreaker,
  registerCircuitBreaker,
  resetCircuitBreakerRegistry,
} from "../circuit-breaker";

describe("CircuitBreaker", () => {
  beforeEach(() => {
    resetCircuitBreakerRegistry();
  });

  describe("state machine: closed → open", () => {
    it("starts in the closed state and passes calls through", async () => {
      const action = vi.fn().mockResolvedValue("ok");
      const breaker = new CircuitBreaker(action, { name: "test-1" });

      expect(breaker.getState()).toBe("closed");

      const result = await breaker.fire();
      expect(result).toBe("ok");
      expect(action).toHaveBeenCalledTimes(1);
    });

    it("opens once errorThresholdPercentage is exceeded over volumeThreshold", async () => {
      const action = vi.fn().mockRejectedValue(new Error("downstream-down"));
      const breaker = new CircuitBreaker(action, {
        name: "test-2",
        volumeThreshold: 5,
        errorThresholdPercentage: 0.5,
        resetTimeout: 10_000,
      });

      // Drive 5 failures — all failures, ratio = 1.0, exceeds 0.5.
      for (let i = 0; i < 5; i++) {
        await expect(breaker.fire()).rejects.toThrow(/downstream-down/);
      }

      expect(breaker.getState()).toBe("open");
      expect(action).toHaveBeenCalledTimes(5);

      // The 6th call short-circuits with CircuitBreakerOpenError.
      await expect(breaker.fire()).rejects.toBeInstanceOf(
        CircuitBreakerOpenError,
      );
      // action should NOT have been called for the short-circuited call.
      expect(action).toHaveBeenCalledTimes(5);
    });

    it("does not open when total calls are below volumeThreshold", async () => {
      const action = vi.fn().mockRejectedValue(new Error("downstream-down"));
      const breaker = new CircuitBreaker(action, {
        name: "test-3",
        volumeThreshold: 10,
        errorThresholdPercentage: 0.5,
      });

      // 4 failures — below volumeThreshold, breaker stays closed.
      for (let i = 0; i < 4; i++) {
        await expect(breaker.fire()).rejects.toThrow();
      }

      expect(breaker.getState()).toBe("closed");
    });

    it("does not open when failure ratio is below threshold", async () => {
      let calls = 0;
      const action = vi.fn().mockImplementation(() => {
        calls++;
        if (calls % 2 === 0) return Promise.resolve("ok");
        return Promise.reject(new Error("flaky"));
      });
      const breaker = new CircuitBreaker(action, {
        name: "test-4",
        volumeThreshold: 5,
        errorThresholdPercentage: 0.6, // 50% failure ratio < 60% threshold
      });

      for (let i = 0; i < 6; i++) {
        try {
          await breaker.fire();
        } catch {
          /* expected */
        }
      }

      expect(breaker.getState()).toBe("closed");
    });
  });

  describe("state machine: open → half-open → closed", () => {
    it("transitions to half-open after resetTimeout and closes on probe success", async () => {
      const fakeTimer = vi.useFakeTimers();
      try {
        let mode: "fail" | "ok" = "fail";
        const action = vi.fn().mockImplementation(() => {
          if (mode === "fail") return Promise.reject(new Error("down"));
          return Promise.resolve("ok");
        });

        const breaker = new CircuitBreaker(action, {
          name: "test-5",
          volumeThreshold: 3,
          errorThresholdPercentage: 0.5,
          resetTimeout: 1_000,
        });

        // Trip the breaker.
        for (let i = 0; i < 3; i++) {
          await expect(breaker.fire()).rejects.toThrow();
        }
        expect(breaker.getState()).toBe("open");

        // Advance past resetTimeout.
        fakeTimer.advanceTimersByTime(1_500);
        // The next call observes the elapsed time and transitions to
        // half-open, then runs the probe.
        mode = "ok";
        const result = await breaker.fire();
        expect(result).toBe("ok");
        expect(breaker.getState()).toBe("closed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-opens when the half-open probe fails", async () => {
      const fakeTimer = vi.useFakeTimers();
      try {
        const action = vi.fn().mockRejectedValue(new Error("still-broken"));
        const breaker = new CircuitBreaker(action, {
          name: "test-6",
          volumeThreshold: 3,
          errorThresholdPercentage: 0.5,
          resetTimeout: 1_000,
        });

        // Trip the breaker.
        for (let i = 0; i < 3; i++) {
          await expect(breaker.fire()).rejects.toThrow();
        }
        expect(breaker.getState()).toBe("open");

        fakeTimer.advanceTimersByTime(1_500);
        // Probe fails → breaker re-opens.
        await expect(breaker.fire()).rejects.toThrow(/still-broken/);
        expect(breaker.getState()).toBe("open");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("isFailure classifier", () => {
    it("treats errors classified as non-failure as successes for the rolling count", async () => {
      const action = vi
        .fn()
        .mockRejectedValueOnce(new Error("bad-request"))
        .mockRejectedValueOnce(new Error("bad-request"))
        .mockResolvedValueOnce("ok")
        .mockResolvedValueOnce("ok")
        .mockResolvedValueOnce("ok");

      const breaker = new CircuitBreaker(action, {
        name: "test-7",
        volumeThreshold: 5,
        errorThresholdPercentage: 0.5,
        isFailure: err =>
          err instanceof Error && !/bad-request/.test(err.message),
      });

      await expect(breaker.fire()).rejects.toThrow(/bad-request/);
      await expect(breaker.fire()).rejects.toThrow(/bad-request/);
      await expect(breaker.fire()).resolves.toBe("ok");
      await expect(breaker.fire()).resolves.toBe("ok");
      await expect(breaker.fire()).resolves.toBe("ok");

      // Only 3 calls classified as success, 2 as non-failure (counted as
      // success). Failure count = 0, so the breaker stays closed even
      // though we hit volumeThreshold.
      expect(breaker.getState()).toBe("closed");
    });
  });

  describe("timeout", () => {
    it("rejects with CircuitBreakerTimeoutError when the action exceeds timeout", async () => {
      const fakeTimer = vi.useFakeTimers();
      try {
        const action = vi
          .fn()
          .mockImplementation(
            () => new Promise(resolve => setTimeout(() => resolve("late"), 5_000)),
          );
        const breaker = new CircuitBreaker(action, {
          name: "test-8",
          timeout: 100,
          volumeThreshold: 1,
        });

        const firePromise = breaker.fire();
        // Allow the microtask queue to flush so the timer is registered.
        await Promise.resolve();
        fakeTimer.advanceTimersByTime(150);

        await expect(firePromise).rejects.toBeInstanceOf(
          CircuitBreakerTimeoutError,
        );
        expect(breaker.getState()).toBe("open");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("stats", () => {
    it("reports rolling-window counts and failure ratio", async () => {
      let calls = 0;
      const action = vi.fn().mockImplementation(() => {
        calls++;
        if (calls % 2 === 0) return Promise.reject(new Error("even"));
        return Promise.resolve("odd");
      });
      const breaker = new CircuitBreaker(action, { name: "test-9" });

      await breaker.fire().catch(() => {});
      await breaker.fire().catch(() => {});
      await breaker.fire().catch(() => {});

      const stats = breaker.getStats();
      expect(stats.total).toBe(3);
      expect(stats.failures).toBe(1);
      expect(stats.successes).toBe(2);
      expect(stats.failureRatio).toBeCloseTo(1 / 3, 5);
      expect(stats.state).toBe("closed");
      expect(stats.openedAt).toBeNull();
    });

    it("reports openedAt once the breaker is open", async () => {
      const action = vi.fn().mockRejectedValue(new Error("down"));
      const breaker = new CircuitBreaker(action, {
        name: "test-10",
        volumeThreshold: 2,
        errorThresholdPercentage: 0.5,
      });

      await expect(breaker.fire()).rejects.toThrow();
      await expect(breaker.fire()).rejects.toThrow();
      expect(breaker.getState()).toBe("open");
      expect(breaker.getStats().openedAt).toBeTypeOf("number");
    });
  });

  describe("module-level registry", () => {
    it("registers and retrieves a breaker by name", () => {
      const action = vi.fn().mockResolvedValue("ok");
      const breaker = new CircuitBreaker(action, { name: "registered-1" });
      registerCircuitBreaker(breaker);

      const found = getCircuitBreaker("registered-1");
      expect(found).toBe(breaker);
    });

    it("createCircuitBreaker registers automatically", () => {
      const breaker = createCircuitBreaker(vi.fn().mockResolvedValue("ok"), {
        name: "created-1",
      });
      expect(getCircuitBreaker("created-1")).toBe(breaker);
    });

    it("resetCircuitBreakerRegistry clears the registry", () => {
      const breaker = createCircuitBreaker(vi.fn().mockResolvedValue("ok"), {
        name: "to-be-reset",
      });
      expect(getCircuitBreaker("to-be-reset")).toBe(breaker);
      resetCircuitBreakerRegistry();
      expect(getCircuitBreaker("to-be-reset")).toBeUndefined();
    });
  });

  describe("CircuitBreakerOpenError metadata", () => {
    it("exposes breakerName and nextRetryAt on the thrown error", async () => {
      const action = vi.fn().mockRejectedValue(new Error("down"));
      const breaker = new CircuitBreaker(action, {
        name: "metadata-test",
        volumeThreshold: 2,
        errorThresholdPercentage: 0.5,
        resetTimeout: 7_777,
      });

      await expect(breaker.fire()).rejects.toThrow();
      await expect(breaker.fire()).rejects.toThrow();

      let caught: unknown;
      try {
        await breaker.fire();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CircuitBreakerOpenError);
      const openErr = caught as CircuitBreakerOpenError;
      expect(openErr.breakerName).toBe("metadata-test");
      expect(openErr.nextRetryAt).toBeGreaterThan(Date.now());
    });
  });
});