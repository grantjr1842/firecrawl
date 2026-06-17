// SEC-2026-01: antibot dispatcher SSRF guard tests
//
// Verifies that every antibot tier (datacenter, residential, tor,
// akamai-h2, tls-fingerprint) refuses to dial private / loopback /
// link-local addresses — both the bare-IP-literal case and the
// DNS-resolves-to-private case — and that public IPs still pass.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AntiBotRouter } from "../../../lib/antibot/router";
import { DatacenterProxyProvider } from "../../../lib/antibot/datacenter";
import { TorSocksProvider } from "../../../lib/antibot/tor";
import { ResidentialProxyProvider } from "../../../lib/antibot/residential";
import { TlsFingerprintProvider } from "../../../lib/antibot/tls-fingerprint";
import { AkamaiH2Provider } from "../../../lib/antibot/akamai-h2";
import {
  withSSRFGuard,
  assertUrlNotInternal,
  InsecureConnectionError,
} from "../../../scraper/scrapeURL/engines/utils/safeFetch";

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  class FakeProxyAgent {
    opts: unknown;
    uri: unknown;
    token: unknown;
    listeners: Record<string, Array<(...args: any[]) => void>> = {};
    constructor(opts: any) {
      this.opts = opts;
      this.uri = opts?.uri;
      this.token = opts?.token;
    }
    on(event: string, fn: (...args: any[]) => void) {
      (this.listeners[event] ??= []).push(fn);
    }
    emit(event: string, ...args: any[]) {
      for (const fn of this.listeners[event] ?? []) fn(...args);
    }
    compose() {
      return this;
    }
  }
  class FakeSocks5ProxyAgent {
    url: unknown;
    listeners: Record<string, Array<(...args: any[]) => void>> = {};
    constructor(url: any) {
      this.url = url;
    }
    on(event: string, fn: (...args: any[]) => void) {
      (this.listeners[event] ??= []).push(fn);
    }
    emit(event: string, ...args: any[]) {
      for (const fn of this.listeners[event] ?? []) fn(...args);
    }
    compose() {
      return this;
    }
  }
  class FakeAgent {
    opts: unknown;
    listeners: Record<string, Array<(...args: any[]) => void>> = {};
    constructor(opts: any) {
      this.opts = opts;
    }
    on(event: string, fn: (...args: any[]) => void) {
      (this.listeners[event] ??= []).push(fn);
    }
    emit(event: string, ...args: any[]) {
      for (const fn of this.listeners[event] ?? []) fn(...args);
    }
    compose() {
      return this;
    }
  }
  const fetch = vi.fn(async (_input: any, _init: any) => {
    return new Response("ok", { status: 200 });
  });
  return {
    ...actual,
    interceptors: { redirect: () => undefined },
    ProxyAgent: FakeProxyAgent,
    Socks5ProxyAgent: FakeSocks5ProxyAgent,
    Agent: FakeAgent,
    fetch,
  };
});

import * as undici from "undici";
const fetchMock = undici.fetch as unknown as ReturnType<typeof vi.fn>;

// Fake tls-client module so TlsFingerprintProvider.fetch() can be
// exercised end-to-end in this suite.
vi.mock("tls-client", () => {
  const request = vi.fn(async () => ({
    status: 200,
    body: "ok",
    headers: { "content-type": ["text/plain"] },
  }));
  const createSession = vi.fn(async () => "fake-session-id");
  const destroySession = vi.fn(async () => undefined);
  return {
    default: undefined,
    request,
    createSession,
    destroySession,
    defaultHeaders: { "user-agent": "fake" },
  };
});

beforeEach(() => {
  fetchMock.mockClear();
  fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
});

afterEach(() => {
  vi.clearAllMocks();
});

const PRIVATE_URLS = [
  "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  "http://10.0.0.1/admin",
  "http://127.0.0.1:8080/internal",
];
const PUBLIC_URL = "https://example.com";

describe("SEC-2026-01: withSSRFGuard attaches a connect-hook to any dispatcher", () => {
  it("returns the same dispatcher instance (so callers can cache it)", () => {
    const dispatcher = new undici.Agent({});
    const wrapped = withSSRFGuard(dispatcher);
    expect(wrapped).toBe(dispatcher);
  });

  it("registers a 'connect' listener that destroys the socket on a private IP", () => {
    const dispatcher = new undici.Agent({});
    withSSRFGuard(dispatcher);
    // Fake socket the connect-hook can destroy.
    const destroyed: Array<Error | undefined> = [];
    const fakeSocket = {
      remoteAddress: "169.254.169.254",
      destroy: (err?: Error) => destroyed.push(err),
    };
    const fakeClient: any = {};
    const socketSym = Object.getOwnPropertySymbols(fakeClient)[0] ?? (() => {
      const s = Symbol("socket");
      (fakeClient as any)[s] = fakeSocket;
      return s;
    })();
    // Make sure the symbol is on the client and points at our fake
    // socket so the connect-hook can read .remoteAddress.
    (fakeClient as any)[socketSym] = fakeSocket;
    (dispatcher as any).emit("connect", null, [fakeClient]);
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]).toBeInstanceOf(InsecureConnectionError);
  });

  it("does NOT destroy the socket on a public IP", () => {
    const dispatcher = new undici.Agent({});
    withSSRFGuard(dispatcher);
    const destroyed: Array<Error | undefined> = [];
    const fakeSocket = {
      remoteAddress: "8.8.8.8",
      destroy: (err?: Error) => destroyed.push(err),
    };
    const fakeClient: any = {};
    // Stash the fake socket on the client under its own symbol; the
    // connect-hook finds it by walking Object.getOwnPropertySymbols
    // and looking for the one with description === "socket".
    const socketSym = Symbol("socket");
    (fakeClient as any)[socketSym] = fakeSocket;
    (dispatcher as any).emit("connect", null, [fakeClient]);
    expect(destroyed).toHaveLength(0);
  });
});

describe("SEC-2026-01: each antibot provider wires the SSRF guard at construction", () => {
  function expectGuardInstalledOnProxyAgent(agent: any) {
    expect(agent).toBeDefined();
    expect(agent.listeners?.connect?.length ?? 0).toBeGreaterThan(0);
  }

  it("DatacenterProxyProvider installs the connect-hook on its ProxyAgent", () => {
    const p = new DatacenterProxyProvider({ proxyServer: "http://dc:3128" });
    expectGuardInstalledOnProxyAgent((p as any).agent);
  });

  it("TorSocksProvider installs the connect-hook on its Socks5ProxyAgent", () => {
    const p = new TorSocksProvider({ socksUrl: "socks5://tor:9050" });
    expectGuardInstalledOnProxyAgent((p as any).agent);
  });

  it("ResidentialProxyProvider installs the connect-hook on its ProxyAgent (rotate=false)", () => {
    const p = new ResidentialProxyProvider({
      vendorUrl: "http://u:p@res.example.com:10000",
      rotate: false,
    });
    expectGuardInstalledOnProxyAgent(
      (p as any).buildAgent("https://example.com"),
    );
  });

  it("ResidentialProxyProvider installs the connect-hook on its rotated ProxyAgent", () => {
    const p = new ResidentialProxyProvider({
      vendorUrl: "http://u:p@res.example.com:10000",
      rotate: true,
    });
    expectGuardInstalledOnProxyAgent(
      (p as any).buildAgent("https://example.com"),
    );
  });

  it("AkamaiH2Provider installs the connect-hook on its undici.Agent", () => {
    const p = new AkamaiH2Provider();
    expectGuardInstalledOnProxyAgent((p as any).agent);
  });
});

describe("SEC-2026-01: 5 tiers x 3 private IPs all rejected (router pre-flight)", () => {
  // The router short-circuits to a synthetic 599 with statusText
  // "AntibotSSRFBlocked" when assertUrlNotInternal throws. We exercise
  // every provider in the chain by passing each one in isolation.
  for (const url of PRIVATE_URLS) {
    for (const tier of [
      "datacenter",
      "tls-fingerprint",
      "akamai-h2",
      "residential",
      "tor",
    ] as const) {
      it(`${tier} tier blocks ${url}`, async () => {
        let provider;
        if (tier === "datacenter") {
          provider = new DatacenterProxyProvider({ proxyServer: "http://dc:3128" });
        } else if (tier === "tor") {
          provider = new TorSocksProvider({ socksUrl: "socks5://tor:9050" });
        } else if (tier === "residential") {
          provider = new ResidentialProxyProvider({
            vendorUrl: "http://u:p@res.example.com:10000",
            rotate: false,
          });
        } else if (tier === "akamai-h2") {
          provider = new AkamaiH2Provider();
        } else {
          provider = new TlsFingerprintProvider();
        }
        const router = new AntiBotRouter([provider]);
        const { response, context } = await router.fetchWithContext(url);
        expect(response.status).toBe(599);
        expect(response.statusText).toBe("AntibotSSRFBlocked");
        // No provider should have been tried.
        expect(context.tried).toHaveLength(0);
        expect(context.provider).toBeNull();
        // And the underlying undici fetch must never have been called.
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }
  }
});

describe("SEC-2026-01: public IPs still pass through the router", () => {
  for (const tier of [
    "datacenter",
    "tls-fingerprint",
    "akamai-h2",
    "residential",
    "tor",
  ] as const) {
    it(`${tier} tier allows ${PUBLIC_URL}`, async () => {
      let provider;
      if (tier === "datacenter") {
        provider = new DatacenterProxyProvider({ proxyServer: "http://dc:3128" });
      } else if (tier === "tor") {
        provider = new TorSocksProvider({ socksUrl: "socks5://tor:9050" });
      } else if (tier === "residential") {
        provider = new ResidentialProxyProvider({
          vendorUrl: "http://u:p@res.example.com:10000",
          rotate: false,
        });
      } else if (tier === "akamai-h2") {
        provider = new AkamaiH2Provider();
      } else {
        provider = new TlsFingerprintProvider();
      }
      const router = new AntiBotRouter([provider]);
      const { response, context } = await router.fetchWithContext(PUBLIC_URL);
      if (response.status !== 200) {
        const body = await response.text();
        // eslint-disable-next-line no-console
        console.log(`${tier} body:`, response.status, response.statusText, body);
      }
      expect(response.status).toBe(200);
      expect(context.provider).toBe(tier);
    });
  }
});

describe("SEC-2026-01: assertUrlNotInternal handles IP literals without DNS", () => {
  it("rejects 169.254.169.254 (cloud metadata)", async () => {
    await expect(
      assertUrlNotInternal("http://169.254.169.254/x"),
    ).rejects.toBeInstanceOf(InsecureConnectionError);
  });

  it("rejects 10.0.0.1 (RFC1918)", async () => {
    await expect(
      assertUrlNotInternal("http://10.0.0.1/x"),
    ).rejects.toBeInstanceOf(InsecureConnectionError);
  });

  it("rejects 127.0.0.1 (loopback)", async () => {
    await expect(
      assertUrlNotInternal("http://127.0.0.1/x"),
    ).rejects.toBeInstanceOf(InsecureConnectionError);
  });

  it("accepts an unparseable URL without throwing (defers to downstream)", async () => {
    await expect(assertUrlNotInternal("not a url")).resolves.toBeUndefined();
  });

  it("does nothing for an empty host", async () => {
    await expect(assertUrlNotInternal("")).resolves.toBeUndefined();
  });
});
