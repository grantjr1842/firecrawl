// ANTI-BOT-6: sticky residential-proxy session tests
//
// Verifies the four documented behavior axes of the new
// FIRECRAWL_PROXY_STICKY_TTL_MS / FIRECRAWL_PROXY_STICKY_SCOPE knobs
// and that the legacy FIRECRAWL_PROXY_VENDOR_ROTATE=true path keeps
// working exactly as it did before (per-request random sessionId,
// 60_000ms eviction in legacy builds, fresh agent per buildAgent call).
//
// These tests mock undici's ProxyAgent so we can capture the
// sessionId baked into the proxy URL on every buildAgent call
// without touching the network.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  class FakeProxyAgent {
    opts: any;
    uri: string;
    constructor(opts: any) {
      this.opts = opts;
      this.uri = opts?.uri ?? "";
    }
  }
  const fetch = vi.fn(async (_input: any, _init: any) => {
    return new Response("ok", { status: 200 });
  });
  return {
    ...actual,
    ProxyAgent: FakeProxyAgent,
    fetch,
  };
});

// Stub the SSRF guard so we don't drag in the full scrapeURL engine
// graph (which transitively requires lots of config). The guard is a
// pure no-op for these tests.
vi.mock(
  "../../../scraper/scrapeURL/engines/utils/safeFetch",
  async () => {
    return {
      withSSRFGuard: <T>(dispatcher: T): T => dispatcher,
    };
  },
);

import * as undici from "undici";
import { ResidentialProxyProvider } from "../../../lib/antibot/residential";
import { SmartproxyVendorAdapter } from "../../../lib/antibot/vendors/smartproxy";
import { BrightDataVendorAdapter } from "../../../lib/antibot/vendors/brightdata";

const SP_CREDS = {
  username: "sp-user-1",
  password: "sppass",
  host: "gate.smartproxy.com",
  port: 7000,
};

const BD_CREDS = {
  username: "brd-customer-1-zone-residential",
  password: "brdpass",
  host: "brd.superproxy.io",
  port: 22225,
};

function sessionIdFromUri(uri: string): string | null {
  const m = uri.match(/-session-([a-z0-9-]+)/);
  return m ? m[1].split("-sesstime")[0] : null;
}

function sesstimeFromUri(uri: string): string | null {
  const m = uri.match(/-sesstime-(\d+)/);
  return m ? m[1] : null;
}

beforeEach(() => {
  (undici.fetch as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ANTI-BOT-6: sticky session scoping (rotate=false)", () => {
  it("scope=crawl: two requests sharing the same scopeKey share the same sessionId", async () => {
    const provider = new ResidentialProxyProvider({
      vendorAdapter: new SmartproxyVendorAdapter(),
      vendorCredentials: SP_CREDS,
      rotate: false,
      sessionTtlMs: 10_000,
      stickyScope: "crawl",
    });
    await provider.fetch("https://example.com/a", {}, { scopeKey: "crawl-1" });
    await provider.fetch("https://example.com/b", {}, { scopeKey: "crawl-1" });
    const uris = (undici.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls.map(c => (c[1] as any).dispatcher.uri);
    expect(uris).toHaveLength(2);
    const s1 = sessionIdFromUri(uris[0]);
    const s2 = sessionIdFromUri(uris[1]);
    expect(s1).toBeTruthy();
    expect(s2).toBe(s1);
  });

  it("scope=crawl: two requests with different scopeKeys get different sessionIds", async () => {
    const provider = new ResidentialProxyProvider({
      vendorAdapter: new SmartproxyVendorAdapter(),
      vendorCredentials: SP_CREDS,
      rotate: false,
      sessionTtlMs: 10_000,
      stickyScope: "crawl",
    });
    await provider.fetch("https://example.com/a", {}, { scopeKey: "crawl-1" });
    await provider.fetch("https://example.com/b", {}, { scopeKey: "crawl-2" });
    const uris = (undici.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls.map(c => (c[1] as any).dispatcher.uri);
    const s1 = sessionIdFromUri(uris[0]);
    const s2 = sessionIdFromUri(uris[1]);
    expect(s1).toBeTruthy();
    expect(s2).toBeTruthy();
    expect(s1).not.toBe(s2);
  });

  it("scope=domain: two requests to the same domain share a sessionId, different domains do not", async () => {
    const provider = new ResidentialProxyProvider({
      vendorAdapter: new SmartproxyVendorAdapter(),
      vendorCredentials: SP_CREDS,
      rotate: false,
      sessionTtlMs: 10_000,
      stickyScope: "domain",
    });
    await provider.fetch("https://amazon.com/p/1", {});
    await provider.fetch("https://amazon.com/p/2", {});
    await provider.fetch("https://yelp.com/biz/1", {});
    const uris = (undici.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls.map(c => (c[1] as any).dispatcher.uri);
    const sameDomain1 = sessionIdFromUri(uris[0]);
    const sameDomain2 = sessionIdFromUri(uris[1]);
    const otherDomain = sessionIdFromUri(uris[2]);
    expect(sameDomain1).toBe(sameDomain2);
    expect(otherDomain).toBeTruthy();
    expect(otherDomain).not.toBe(sameDomain1);
  });

  it("Smartproxy adapter embeds sesstime-<minutes> derived from sessionTtlMs", async () => {
    const provider = new ResidentialProxyProvider({
      vendorAdapter: new SmartproxyVendorAdapter(),
      vendorCredentials: SP_CREDS,
      rotate: false,
      sessionTtlMs: 600_000, // 10 min
      stickyScope: "crawl",
    });
    await provider.fetch("https://example.com/a", {}, { scopeKey: "crawl-1" });
    const uris = (undici.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls.map(c => (c[1] as any).dispatcher.uri);
    expect(uris).toHaveLength(1);
    expect(uris[0]).toContain("-sesstime-10");
  });

  it("Bright Data adapter also embeds sesstime-<minutes> from sessionTtlMs", async () => {
    const provider = new ResidentialProxyProvider({
      vendorAdapter: new BrightDataVendorAdapter(),
      vendorCredentials: BD_CREDS,
      rotate: false,
      sessionTtlMs: 60_000, // 1 min
      stickyScope: "crawl",
    });
    await provider.fetch("https://example.com/a", {}, { scopeKey: "crawl-1" });
    const uris = (undici.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls.map(c => (c[1] as any).dispatcher.uri);
    expect(uris).toHaveLength(1);
    expect(uris[0]).toContain("-sesstime-1");
  });

  it("sub-minute sessionTtlMs is floored to 1 minute so the sesstime token stays valid", async () => {
    const provider = new ResidentialProxyProvider({
      vendorAdapter: new SmartproxyVendorAdapter(),
      vendorCredentials: SP_CREDS,
      rotate: false,
      sessionTtlMs: 5_000, // 5s — absurdly short, but the token must still be parseable
      stickyScope: "crawl",
    });
    await provider.fetch("https://example.com/a", {}, { scopeKey: "crawl-1" });
    const uris = (undici.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls.map(c => (c[1] as any).dispatcher.uri);
    expect(uris[0]).toContain("-sesstime-1");
  });
});

describe("ANTI-BOT-6: legacy rotate=true behavior is preserved", () => {
  it("every request gets a fresh random sessionId when rotate=true", async () => {
    const provider = new ResidentialProxyProvider({
      vendorAdapter: new SmartproxyVendorAdapter(),
      vendorCredentials: SP_CREDS,
      rotate: true,
      sessionTtlMs: 10_000,
      stickyScope: "crawl",
    });
    const N = 6;
    for (let i = 0; i < N; i++) {
      await provider.fetch("https://example.com/x", {}, {
        scopeKey: "crawl-1",
      });
    }
    const uris = (undici.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls.map(c => (c[1] as any).dispatcher.uri);
    const ids = uris.map(sessionIdFromUri);
    // All ids must be present and distinct.
    const unique = new Set(ids);
    expect(unique.size).toBe(N);
  });
});

describe("ANTI-BOT-6: eviction TTL matches sessionTtlMs", () => {
  it("the same scope key reuses the cached agent within the TTL window", async () => {
    const provider = new ResidentialProxyProvider({
      vendorAdapter: new SmartproxyVendorAdapter(),
      vendorCredentials: SP_CREDS,
      rotate: false,
      sessionTtlMs: 10_000,
      stickyScope: "crawl",
    });
    await provider.fetch("https://example.com/a", {}, { scopeKey: "crawl-1" });
    await provider.fetch("https://example.com/b", {}, { scopeKey: "crawl-1" });
    await provider.fetch("https://example.com/c", {}, { scopeKey: "crawl-1" });
    const dispatchers = (undici.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls.map(c => (c[1] as any).dispatcher);
    // Same ProxyAgent instance for all three (cached).
    expect(dispatchers[0]).toBe(dispatchers[1]);
    expect(dispatchers[1]).toBe(dispatchers[2]);
  });

  it("the cached agent is reused until sessionTtlMs elapses (fake timer advance)", async () => {
    vi.useFakeTimers();
    const provider = new ResidentialProxyProvider({
      vendorAdapter: new SmartproxyVendorAdapter(),
      vendorCredentials: SP_CREDS,
      rotate: false,
      sessionTtlMs: 1_000, // 1s
      stickyScope: "crawl",
    });
    await provider.fetch("https://example.com/a", {}, { scopeKey: "crawl-1" });
    // Within the window: cached, same instance.
    await provider.fetch("https://example.com/b", {}, { scopeKey: "crawl-1" });
    vi.advanceTimersByTime(1_500);
    // Past the window: a new ProxyAgent is built.
    await provider.fetch("https://example.com/c", {}, { scopeKey: "crawl-1" });
    const dispatchers = (undici.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls.map(c => (c[1] as any).dispatcher);
    expect(dispatchers[0]).toBe(dispatchers[1]);
    expect(dispatchers[1]).not.toBe(dispatchers[2]);
  });
});
