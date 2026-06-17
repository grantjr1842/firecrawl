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

import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { AntiBotProvider } from "./types";
import type { VendorAdapter, VendorBuildOptions } from "./vendors/types";

export interface ResidentialProviderOptions {
  /** Legacy: full URL including scheme and credentials. */
  vendorUrl?: string;
  /** Rotate a fresh session per request. */
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
}

export class ResidentialProxyProvider implements AntiBotProvider {
  readonly name = "residential";
  readonly tier = "residential" as const;
  private readonly vendorUrl?: string;
  private readonly rotate: boolean;
  private readonly vendorAdapter?: VendorAdapter;
  private readonly vendorCredentials?: ResidentialProviderOptions["vendorCredentials"];
  private readonly geo?: string;
  private readonly agentCache = new Map<string, ProxyAgent>();

  constructor(opts: ResidentialProviderOptions) {
    this.vendorUrl = opts.vendorUrl;
    this.rotate = opts.rotate;
    this.vendorAdapter = opts.vendorAdapter;
    this.vendorCredentials = opts.vendorCredentials;
    this.geo = opts.geo;

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

  private buildAgent(): ProxyAgent {
    if (this.vendorAdapter && this.vendorCredentials) {
      const sessionId = this.rotate
        ? Math.random().toString(36).slice(2, 10)
        : undefined;
      const buildOpts: VendorBuildOptions = {
        target: "https://example.invalid/",
        ...(sessionId ? { sessionId } : {}),
        ...(this.geo ? { geo: this.geo } : {}),
      };
      const url = this.vendorAdapter.buildProxyUrl(
        this.vendorCredentials,
        buildOpts,
      );
      const agent = new ProxyAgent({ uri: url });
      if (sessionId) {
        this.agentCache.set(sessionId, agent);
        setTimeout(
          () => this.agentCache.delete(sessionId),
          60_000,
        ).unref();
      }
      return agent;
    }
    if (!this.vendorUrl) {
      throw new Error(
        "ResidentialProxyProvider: no vendorUrl and no vendorAdapter configured",
      );
    }
    if (!this.rotate) {
      return new ProxyAgent({ uri: this.vendorUrl });
    }
    const sessionId = Math.random().toString(36).slice(2, 10);
    const [scheme, rest] = this.vendorUrl.includes("://")
      ? this.vendorUrl.split("://")
      : ["http", this.vendorUrl];
    const rotated = `${scheme}://${rest.replace(
      /(@)/,
      `-session-${sessionId}$1`,
    )}`;
    const agent = new ProxyAgent({ uri: rotated });
    this.agentCache.set(sessionId, agent);
    setTimeout(() => this.agentCache.delete(sessionId), 60_000).unref();
    return agent;
  }

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const agent = this.buildAgent();
    return undiciFetch(input as any, {
      ...(init as any),
      dispatcher: agent,
    }) as unknown as Response;
  }
}
