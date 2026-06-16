// Residential proxy vendor provider
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { AntiBotProvider } from "./types";

export interface ResidentialProviderOptions {
  vendorUrl: string;
  rotate: boolean;
}

export class ResidentialProxyProvider implements AntiBotProvider {
  readonly name = "residential";
  readonly tier = "residential" as const;
  private readonly vendorUrl: string;
  private readonly rotate: boolean;
  private readonly agentCache = new Map<string, ProxyAgent>();

  constructor(opts: ResidentialProviderOptions) {
    this.vendorUrl = opts.vendorUrl;
    this.rotate = opts.rotate;
  }

  describe(): string {
    return this.vendorUrl.replace(/\/\/[^@]+@/, "//***@");
  }

  private buildAgent(): ProxyAgent {
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
