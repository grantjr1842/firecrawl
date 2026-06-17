// Tor SOCKS5 provider
import { Socks5ProxyAgent, fetch as undiciFetch } from "undici";
import type { AntiBotProvider } from "./types";
import { withSSRFGuard } from "../../scraper/scrapeURL/engines/utils/safeFetch";

export interface TorProviderOptions {
  socksUrl: string;
}

export class TorSocksProvider implements AntiBotProvider {
  readonly name = "tor";
  readonly tier = "tor" as const;
  private readonly agent: Socks5ProxyAgent;
  private readonly socksUrl: string;

  constructor(opts: TorProviderOptions) {
    this.socksUrl = opts.socksUrl;
    // SEC-2026-01: wrap the SOCKS5 dispatcher with the SSRF guard.
    // Tor exits resolve arbitrary hostnames, so a hostile URL like
    // http://169.254.169.254/... would otherwise tunnel straight
    // through to the cloud metadata service.
    this.agent = withSSRFGuard(new Socks5ProxyAgent(opts.socksUrl));
  }

  describe(): string {
    return this.socksUrl;
  }

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    return undiciFetch(input as any, {
      ...(init as any),
      dispatcher: this.agent,
    }) as unknown as Response;
  }
}
