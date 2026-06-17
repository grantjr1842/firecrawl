// Residential proxy vendor provider
//
// Routes outbound requests through a residential proxy. Supports two
// modes:
//
//   1. **Vendor adapter** (preferred for production) — pass a
//      `VendorAdapter` (e.g. BrightDataVendorAdapter,
//      SmartproxyVendorAdapter) to delegate credential formatting and
//      session-id injection to a vendor-specific implementation.
//   2. **Legacy URL** — pass `vendorUrl` and the provider will use the
//      historical session-rotation scheme (replace `@` with
//      `-session-<id>@`). This is the fallback for the "generic"
//      vendor and for self-hosters using arbitrary residential
//      vendors.

import { createHash } from "crypto";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { AntiBotProvider } from "./types";
import type { VendorAdapter, VendorBuildOptions } from "./vendors/types";
import { withSSRFGuard } from "../../scraper/scrapeURL/engines/utils/safeFetch";

export type StickyScope = "session" | "crawl" | "domain";

export interface ResidentialProviderOptions {
  /** Legacy: full URL including scheme and credentials. */
  vendorUrl?: string;
  /** Rotate a fresh session per request. Defaults to false (sticky). */
  rotate: boolean;
  /**
   * Optional vendor adapter. When supplied, the adapter's
   * `buildProxyUrl` is used to construct the dial URL for every
   * request. When omitted, falls back to the legacy
   * `vendorUrl` + session-id-injection scheme.
   */
  vendorAdapter?: VendorAdapter;
  /**
   * Credentials to hand to the vendor adapter. Required when
   * `vendorAdapter` is set; ignored otherwise.
   */
  vendorCredentials?: {
    username: string;
    password: string;
    host: string;
    port: number;
  };
  /**
   * Optional ISO-3166 alpha-2 country code (e.g. "us", "de"). Forwarded
   * to the vendor adapter for geo-targeted routing.
   */
  geo?: string;
  /**
   * ANTI-BOT-6: sticky-session TTL in milliseconds. The provider
   * pins the same exit node for at most this many milliseconds; the
   * in-process agent cache entry is evicted at the same boundary so
   * the next request re-dials and gets a fresh session. Default
   * 600_000 (10 min).
   */
  sessionTtlMs?: number;
  /**
   * ANTI-BOT-6: scope key for the sticky session id.
   *  - `session`: a fresh id per `fetch` call (legacy behavior when
   *    `rotate` is true).
   *  - `crawl`: the caller-supplied `scopeKey` (e.g. the crawl id).
   *  - `domain`: the hostname of the upstream target.
   *
   * `session` and `crawl` both produce a stable id per scope key for
   * the TTL window; `domain` shares one id per upstream host.
   */
  stickyScope?: StickyScope;
}

export interface ResidentialFetchOptions {
  /**
   * Caller-supplied scope key (e.g. crawl id) for sticky-session
   * scoping. Only consulted when `stickyScope === "crawl"` (or when
   * the caller wants to override the URL-derived domain key).
   */
  scopeKey?: string;
}

export class ResidentialProxyProvider implements AntiBotProvider {
  readonly name = "residential";
  readonly tier = "residential" as const;
  private readonly vendorUrl?: string;
  private readonly rotate: boolean;
  private readonly vendorAdapter?: VendorAdapter;
  private readonly vendorCredentials?: ResidentialProviderOptions["vendorCredentials"];
  private readonly geo?: string;
  private readonly sessionTtlMs: number;
  private readonly stickyScope: StickyScope;
  private readonly agentCache = new Map<string, ProxyAgent>();

  constructor(opts: ResidentialProviderOptions) {
    this.vendorUrl = opts.vendorUrl;
    this.rotate = opts.rotate;
    this.vendorAdapter = opts.vendorAdapter;
    this.vendorCredentials = opts.vendorCredentials;
    this.geo = opts.geo;
    this.sessionTtlMs = opts.sessionTtlMs ?? 600_000;
    this.stickyScope = opts.stickyScope ?? "crawl";

    if (opts.vendorAdapter && !opts.vendorCredentials) {
      throw new Error(
        "ResidentialProxyProvider: vendorCredentials is required when " +
          "vendorAdapter is supplied",
      );
    }
  }

  describe(): string {
    if (this.vendorAdapter) {
      return `${this.vendorAdapter.label} vendor adapter`;
    }
    if (this.vendorUrl) {
      return this.vendorUrl.replace(/\/\/[^@]+@/, "//***@");
    }
    return "residential (unconfigured)";
  }

  /**
   * Derive a stable `sessionId` for the sticky window. We hash the
   * scope key so that the id is short enough to embed in the vendor
   * username (some vendors cap at ~50 chars) and consistent across
   * requests that share the same scope. The id rotates naturally
   * once the agent cache entry is evicted.
   */
  private deriveStickySessionId(scopeKey: string): string {
    return createHash("sha256")
      .update(scopeKey)
      .digest("hex")
      .slice(0, 16);
  }

  private resolveScopeKey(
    input: string | URL,
    fetchOpts?: ResidentialFetchOptions,
  ): string {
    if (this.stickyScope === "session") {
      // Caller asked for a fresh id per call; fall through to the
      // random branch in buildAgent.
      return "";
    }
    if (this.stickyScope === "crawl") {
      if (fetchOpts?.scopeKey) return `crawl:${fetchOpts.scopeKey}`;
      // No caller-provided crawl id: degrade to the URL host so we
      // still get *some* stickiness instead of per-request churn.
      return `crawl-host:${hostOf(input)}`;
    }
    // `domain` scope.
    const explicit = fetchOpts?.scopeKey?.trim();
    if (explicit) return `domain:${explicit.toLowerCase()}`;
    return `domain:${hostOf(input)}`;
  }

  private buildAgent(
    input: string | URL,
    fetchOpts?: ResidentialFetchOptions,
  ): ProxyAgent {
    if (this.vendorAdapter && this.vendorCredentials) {
      let sessionId: string | undefined;
      if (this.rotate) {
        sessionId = Math.random().toString(36).slice(2, 10);
      } else if (this.stickyScope !== "session") {
        const key = this.resolveScopeKey(input, fetchOpts);
        if (key) sessionId = this.deriveStickySessionId(key);
      }
      // ANTI-BOT-6: when we have a stable sessionId (sticky mode)
      // and the agent cache already holds an entry for it, reuse the
      // cached ProxyAgent so we don't open a fresh TCP/TLS pool per
      // call. The eviction timer in `cacheAgent` guarantees the
      // entry disappears after `sessionTtlMs`.
      if (sessionId) {
        const hit = this.agentCache.get(sessionId);
        if (hit) return hit;
      }
      const buildOpts: VendorBuildOptions = {
        target:
          typeof input === "string"
            ? input
            : input.toString(),
        ...(sessionId ? { sessionId } : {}),
        ...(this.sessionTtlMs ? { sessionTtlMs: this.sessionTtlMs } : {}),
        ...(this.geo ? { geo: this.geo } : {}),
      };
      const url = this.vendorAdapter.buildProxyUrl(
        this.vendorCredentials,
        buildOpts,
      );
      // SEC-2026-01: wrap the ProxyAgent with the SSRF guard so the
      // connect-hook destroys any socket that resolves to a private
      // IP. Without this, the residential proxy could be used to
      // exfiltrate cloud metadata or VPC internal targets.
      const agent = withSSRFGuard(new ProxyAgent({ uri: url }));
      if (sessionId) {
        this.cacheAgent(sessionId, agent);
      }
      return agent;
    }
    if (!this.vendorUrl) {
      throw new Error(
        "ResidentialProxyProvider: no vendorUrl and no vendorAdapter configured",
      );
    }
    if (!this.rotate) {
      return withSSRFGuard(new ProxyAgent({ uri: this.vendorUrl }));
    }
    const sessionId = Math.random().toString(36).slice(2, 10);
    const [scheme, rest] = this.vendorUrl.includes("://")
      ? this.vendorUrl.split("://")
      : ["http", this.vendorUrl];
    const rotated = `${scheme}://${rest.replace(
      /(@)/,
      `-session-${sessionId}$1`,
    )}`;
    const agent = withSSRFGuard(new ProxyAgent({ uri: rotated }));
    this.cacheAgent(sessionId, agent);
    return agent;
  }

  private cacheAgent(sessionId: string, agent: ProxyAgent): void {
    // Idempotent insert: don't double-arm the eviction timer if the
    // same scope key has already populated the cache.
    if (this.agentCache.has(sessionId)) return;
    this.agentCache.set(sessionId, agent);
    setTimeout(
      () => this.agentCache.delete(sessionId),
      this.sessionTtlMs,
    ).unref();
  }

  async fetch(
    input: string | URL,
    init: RequestInit = {},
    fetchOpts?: ResidentialFetchOptions,
  ): Promise<Response> {
    const agent = this.buildAgent(input, fetchOpts);
    return undiciFetch(input as any, {
      ...(init as any),
      dispatcher: agent,
    }) as unknown as Response;
  }
}

function hostOf(input: string | URL): string {
  try {
    const url = typeof input === "string" ? new URL(input) : input;
    return url.hostname.toLowerCase();
  } catch {
    return "";
  }
}
