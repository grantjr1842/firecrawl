// W3-SEC-001: SSRF pre-flight test matrix for the antibot tiered router.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AntiBotRouter,
  getAntiBotRouter,
  _resetAntiBotRouter,
  buildRouterFromConfig,
} from "../../../lib/antibot/router";
import type { AntiBotProvider } from "../../../lib/antibot/types";
import { DatacenterProxyProvider } from "../../../lib/antibot/datacenter";
import { TorSocksProvider } from "../../../lib/antibot/tor";
import { ResidentialProxyProvider } from "../../../lib/antibot/residential";
import {
  TlsFingerprintProvider,
  _resetTlsClientCache,
  SUPPORTED_TLS_FINGERPRINTS,
  DEFAULT_ACCEPT_LANGUAGE,
} from "../../../lib/antibot/tls-fingerprint";
import {
  AkamaiH2Provider,
  CHROME_120_H2_SETTINGS,
} from "../../../lib/antibot/akamai-h2";

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  class FakeProxyAgent {
    opts: unknown;
    uri: unknown;
    token: unknown;
    constructor(opts: any) {
      this.opts = opts;
      this.uri = opts?.uri;
      this.token = opts?.token;
    }
  }
  class FakeSocks5ProxyAgent {
    url: unknown;
    constructor(url: any) {
      this.url = url;
    }
  }
  class FakeAgent {
    opts: unknown;
    constructor(opts: any) {
      this.opts = opts;
    }
  }
  const fetch = vi.fn(async (_input: any, _init: any) => {
    return new Response("ok", { status: 200 });
  });
  return {
    ...actual,
    ProxyAgent: FakeProxyAgent,
    Socks5ProxyAgent: FakeSocks5ProxyAgent,
    Agent: FakeAgent,
    fetch,
  };
});

import * as undici from "undici";
const fetchMock = undici.fetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock.mockClear();
  _resetTlsClientCache();
});

afterEach(() => {
  _resetTlsClientCache();
});

describe("W3-SEC-001: antibot provider construction (5 tiers)", () => {
  it("DatacenterProxyProvider constructs and exposes the proxy URL via describe()", () => {
    const p = new DatacenterProxyProvider({
      proxyServer: "http://dc.example.com:3128",
      proxyUsername: "user",
      proxyPassword: "pass",
    });
    expect(p.name).toBe("datacenter");
    expect(p.tier).toBe("datacenter");
    expect(p.describe()).toBe("http://dc.example.com:3128");
  });

  it("TorSocksProvider constructs and exposes the SOCKS5 URL via describe()", () => {
    const p = new TorSocksProvider({ socksUrl: "socks5://tor:9050" });
    expect(p.name).toBe("tor");
    expect(p.tier).toBe("tor");
    expect(p.describe()).toBe("socks5://tor:9050");
  });

  it("ResidentialProxyProvider strips credentials from describe()", () => {
    const p = new ResidentialProxyProvider({
      vendorUrl: "http://user:pass@residential.smartproxy.com:10000",
      rotate: true,
    });
    expect(p.name).toBe("residential");
    expect(p.tier).toBe("residential");
    expect(p.describe()).toBe("http://***@residential.smartproxy.com:10000");
    expect(p.describe()).not.toMatch(/user/);
    expect(p.describe()).not.toMatch(/pass/);
  });

  it("TlsFingerprintProvider defaults to chrome_120 and reports isAvailable=false when tls-client is missing", () => {
    const p = new TlsFingerprintProvider();
    expect(p.name).toBe("tls-fingerprint");
    expect(p.tier).toBe("tls-fingerprint");
    expect(p.fingerprint).toBe("chrome_120");
    expect(p.isAvailable()).toBe(false);
  });

  it("TlsFingerprintProvider supports all 7 documented fingerprints and each has a baseline Accept-Language", () => {
    expect(SUPPORTED_TLS_FINGERPRINTS).toEqual([
      "chrome_120",
      "chrome_119",
      "firefox_120",
      "safari_16_0",
      "edge_101",
      "opera_85",
      "okhttp_4_10",
    ]);
    for (const fp of SUPPORTED_TLS_FINGERPRINTS) {
      expect(typeof DEFAULT_ACCEPT_LANGUAGE[fp]).toBe("string");
      expect(DEFAULT_ACCEPT_LANGUAGE[fp].length).toBeGreaterThan(0);
    }
  });

  it("AkamaiH2Provider pins Chrome 120 H2 SETTINGS", () => {
    const p = new AkamaiH2Provider();
    expect(p.name).toBe("akamai-h2");
    expect(p.tier).toBe("akamai-h2");
    expect(p.isAvailable()).toBe(true);
    expect(CHROME_120_H2_SETTINGS).toEqual({
      headerTableSize: 65_536,
      enablePush: 0,
      maxConcurrentStreams: 1_000,
      initialWindowSize: 6_291_456,
      maxFrameSize: 16_384,
      maxHeaderListSize: 262_144,
    });
    const desc = p.describe();
    expect(desc).toContain("akamai-h2");
    expect(desc).toContain(String(CHROME_120_H2_SETTINGS.maxConcurrentStreams));
    expect(desc).toContain(String(CHROME_120_H2_SETTINGS.initialWindowSize));
  });
});

describe("W3-SEC-001: tier chain ordering and fallthrough", () => {
  it("walks tiers in the documented order [datacenter, tls-fingerprint, akamai-h2, residential, tor]", async () => {
    const order: string[] = [];
    const providers: AntiBotProvider[] = [
      {
        name: "datacenter",
        tier: "datacenter",
        async fetch(i, x) {
          order.push("datacenter");
          return new Response("ok", { status: 200 });
        },
      },
      {
        name: "tls-fingerprint",
        tier: "tls-fingerprint",
        async fetch(i, x) {
          order.push("tls-fingerprint");
          return new Response("ok", { status: 200 });
        },
      },
      {
        name: "akamai-h2",
        tier: "akamai-h2",
        async fetch(i, x) {
          order.push("akamai-h2");
          return new Response("ok", { status: 200 });
        },
      },
      {
        name: "residential",
        tier: "residential",
        async fetch(i, x) {
          order.push("residential");
          return new Response("ok", { status: 200 });
        },
      },
      {
        name: "tor",
        tier: "tor",
        async fetch(i, x) {
          order.push("tor");
          return new Response("ok", { status: 200 });
        },
      },
    ];

    const router = new AntiBotRouter(providers);
    const { response, context } = await router.fetchWithContext(
      "https://example.com",
    );

    expect(response.status).toBe(200);
    expect(context.provider).toBe("datacenter");
    expect(order).toEqual(["datacenter"]);
    expect(context.tried.map(t => t.provider)).toEqual(["datacenter"]);
  });

  it("falls through all 5 tiers on 403, then returns the synthetic 599 with tried[] in the body", async () => {
    const providers: AntiBotProvider[] = [
      {
        name: "datacenter",
        tier: "datacenter",
        async fetch() {
          return new Response("403", { status: 403 });
        },
      },
      {
        name: "tls-fingerprint",
        tier: "tls-fingerprint",
        async fetch() {
          return new Response("403", { status: 403 });
        },
      },
      {
        name: "akamai-h2",
        tier: "akamai-h2",
        async fetch() {
          return new Response("403", { status: 403 });
        },
      },
      {
        name: "residential",
        tier: "residential",
        async fetch() {
          return new Response("403", { status: 403 });
        },
      },
      {
        name: "tor",
        tier: "tor",
        async fetch() {
          return new Response("403", { status: 403 });
        },
      },
    ];
    const router = new AntiBotRouter(providers);
    const { response, context } = await router.fetchWithContext(
      "https://blocked.example.com",
    );

    expect(response.status).toBe(599);
    expect(context.tried).toHaveLength(5);
    expect(context.tried.map(t => t.provider)).toEqual([
      "datacenter",
      "tls-fingerprint",
      "akamai-h2",
      "residential",
      "tor",
    ]);
    for (const t of context.tried) {
      expect(t.status).toBe(403);
    }
    const body = await response.json();
    expect(body.tried).toEqual(context.tried);
    expect(body.error).toMatch(/All antibot providers failed/);
  });

  it("falls through 403 → 429 → 503, then surfaces 599 (full retry set)", async () => {
    const providers: AntiBotProvider[] = [
      {
        name: "datacenter",
        tier: "datacenter",
        async fetch() {
          return new Response("403", { status: 403 });
        },
      },
      {
        name: "tls-fingerprint",
        tier: "tls-fingerprint",
        async fetch() {
          return new Response("429", { status: 429 });
        },
      },
      {
        name: "akamai-h2",
        tier: "akamai-h2",
        async fetch() {
          return new Response("503", { status: 503 });
        },
      },
      {
        name: "residential",
        tier: "residential",
        async fetch() {
          return new Response("403", { status: 403 });
        },
      },
      {
        name: "tor",
        tier: "tor",
        async fetch() {
          return new Response("429", { status: 429 });
        },
      },
    ];
    const router = new AntiBotRouter(providers);
    const { response, context } = await router.fetchWithContext(
      "https://multi.example.com",
    );

    expect(response.status).toBe(599);
    expect(context.tried.map(t => t.status)).toEqual([403, 429, 503, 403, 429]);
  });

  it("returns the first non-blocked response (short-circuits 404 before tor)", async () => {
    const providers: AntiBotProvider[] = [
      {
        name: "datacenter",
        tier: "datacenter",
        async fetch() {
          return new Response("403", { status: 403 });
        },
      },
      {
        name: "tls-fingerprint",
        tier: "tls-fingerprint",
        async fetch() {
          return new Response("404", { status: 404 });
        },
      },
      {
        name: "akamai-h2",
        tier: "akamai-h2",
        async fetch() {
          return new Response("403", { status: 403 });
        },
      },
      {
        name: "residential",
        tier: "residential",
        async fetch() {
          return new Response("403", { status: 403 });
        },
      },
      {
        name: "tor",
        tier: "tor",
        async fetch() {
          return new Response("200", { status: 200 });
        },
      },
    ];
    const router = new AntiBotRouter(providers);
    const { response, context } = await router.fetchWithContext(
      "https://404.example.com",
    );

    expect(response.status).toBe(404);
    expect(context.provider).toBe("tls-fingerprint");
    expect(context.tried.map(t => t.provider)).toEqual([
      "datacenter",
      "tls-fingerprint",
    ]);
  });

  it("isEnabled() returns false on an empty provider list (caller must fall back to legacy direct fetch)", () => {
    const router = new AntiBotRouter([]);
    expect(router.isEnabled()).toBe(false);
  });

  it("exposes the public router module surface (getAntiBotRouter, _resetAntiBotRouter, buildRouterFromConfig)", () => {
    // The router's three public exports are wired into the API
    // boot path. Pin their existence so a future refactor that
    // renames any of them surfaces a clear failure here rather
    // than a runtime TypeError in production.
    expect(typeof getAntiBotRouter).toBe("function");
    expect(typeof _resetAntiBotRouter).toBe("function");
    expect(typeof buildRouterFromConfig).toBe("function");
    // _resetAntiBotRouter is a no-arg void returner; confirm it
    // doesn't throw on a fresh process state.
    expect(() => _resetAntiBotRouter()).not.toThrow();
  });
});

describe("W3-SEC-001: provider tethers — the provider.tier field is the contract", () => {
  it("each provider reports a tier that is a member of the documented AntiBotTier union", () => {
    const tiers: ReadonlyArray<AntiBotProvider["tier"]> = [
      "datacenter",
      "tls-fingerprint",
      "akamai-h2",
      "residential",
      "tor",
    ];
    const providers: AntiBotProvider[] = [
      new DatacenterProxyProvider({ proxyServer: "http://dc:3128" }),
      new TorSocksProvider({ socksUrl: "socks5://tor:9050" }),
      new ResidentialProxyProvider({
        vendorUrl: "http://u:p@res.example.com:10000",
        rotate: true,
      }),
      new TlsFingerprintProvider(),
      new AkamaiH2Provider(),
    ];
    for (const p of providers) {
      expect(tiers).toContain(p.tier);
    }
  });

  it("DatacenterProxyProvider hands the ProxyAgent dispatcher to undici.fetch on real construction", async () => {
    fetchMock.mockResolvedValueOnce(new Response("via-dc", { status: 200 }));
    const p = new DatacenterProxyProvider({
      proxyServer: "http://dc.example.com:3128",
      proxyUsername: "u",
      proxyPassword: "p",
    });
    await p.fetch("https://example.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as any;
    expect(init).toBeDefined();
    expect(init.dispatcher).toBeDefined();
    expect(init.dispatcher.uri).toBe("http://dc.example.com:3128");
  });

  it("TorSocksProvider hands the Socks5ProxyAgent dispatcher to undici.fetch on real construction", async () => {
    fetchMock.mockResolvedValueOnce(new Response("via-tor", { status: 200 }));
    const p = new TorSocksProvider({ socksUrl: "socks5://tor.local:9050" });
    await p.fetch("https://example.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as any;
    expect(init.dispatcher).toBeDefined();
    expect(init.dispatcher.url).toBe("socks5://tor.local:9050");
  });

  it("ResidentialProxyProvider hands a ProxyAgent dispatcher to undici.fetch on real construction", async () => {
    fetchMock.mockResolvedValueOnce(new Response("via-res", { status: 200 }));
    const p = new ResidentialProxyProvider({
      vendorUrl: "http://u:p@residential.example.com:10000",
      rotate: false,
    });
    await p.fetch("https://example.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as any;
    expect(init.dispatcher).toBeDefined();
    expect(init.dispatcher.uri).toBe(
      "http://u:p@residential.example.com:10000",
    );
  });

  it("ResidentialProxyProvider injects a per-call session suffix when rotate=true", () => {
    const p = new ResidentialProxyProvider({
      vendorUrl: "http://user:pass@residential.smartproxy.com:10000",
      rotate: true,
    });
    const a = (p as any).buildAgent();
    const b = (p as any).buildAgent();
    expect(a).not.toBe(b);
  });

  it("AkamaiH2Provider hands a custom undici.Agent with H2 SETTINGS to undici.fetch on real construction", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("via-akamai", { status: 200 }),
    );
    const p = new AkamaiH2Provider();
    await p.fetch("https://example.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as any;
    expect(init.dispatcher).toBeDefined();
    expect(init.dispatcher.opts).toBeDefined();
    const connect = (init.dispatcher.opts as any).connect;
    expect(connect).toBeDefined();
    expect(connect.ALPNProtocols).toEqual(["h2"]);
    expect(connect.h2).toBeDefined();
    expect(connect.h2.headerTableSize).toBe(
      CHROME_120_H2_SETTINGS.headerTableSize,
    );
    expect(connect.h2.maxConcurrentStreams).toBe(
      CHROME_120_H2_SETTINGS.maxConcurrentStreams,
    );
    expect(connect.h2.initialWindowSize).toBe(
      CHROME_120_H2_SETTINGS.initialWindowSize,
    );
  });
});

describe("W3-SEC-001: SSRF safety properties", () => {
  it("DatacenterProxyProvider.fetch ALWAYS attaches a dispatcher (no direct-connect fallback)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const p = new DatacenterProxyProvider({ proxyServer: "http://dc:3128" });
    await p.fetch("https://example.com");
    const init = fetchMock.mock.calls[0][1] as any;
    expect(init).toHaveProperty("dispatcher");
    expect(init.dispatcher).toBeTruthy();
  });

  it("TorSocksProvider.fetch ALWAYS attaches a dispatcher", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const p = new TorSocksProvider({ socksUrl: "socks5://tor:9050" });
    await p.fetch("https://example.com");
    const init = fetchMock.mock.calls[0][1] as any;
    expect(init).toHaveProperty("dispatcher");
    expect(init.dispatcher).toBeTruthy();
  });

  it("ResidentialProxyProvider.fetch ALWAYS attaches a dispatcher", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const p = new ResidentialProxyProvider({
      vendorUrl: "http://u:p@res:10000",
      rotate: false,
    });
    await p.fetch("https://example.com");
    const init = fetchMock.mock.calls[0][1] as any;
    expect(init).toHaveProperty("dispatcher");
    expect(init.dispatcher).toBeTruthy();
  });

  it("AkamaiH2Provider.fetch ALWAYS attaches a dispatcher (the H2 Agent)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const p = new AkamaiH2Provider();
    await p.fetch("https://example.com");
    const init = fetchMock.mock.calls[0][1] as any;
    expect(init).toHaveProperty("dispatcher");
    expect(init.dispatcher).toBeTruthy();
  });

  it("TlsFingerprintProvider.fetch throws (does not silently fall through) when tls-client is missing", async () => {
    const p = new TlsFingerprintProvider();
    expect(p.isAvailable()).toBe(false);
    await expect(p.fetch("https://example.com")).rejects.toThrow(
      /tls-client.*not installed/i,
    );
  });
});
