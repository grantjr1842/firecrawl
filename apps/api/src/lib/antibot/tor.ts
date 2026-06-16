// Tor SOCKS5 provider
import { Socks5ProxyAgent, fetch as undiciFetch } from "undici";
import type { AntiBotProvider } from "./types";

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
    this.agent = new Socks5ProxyAgent(opts.socksUrl);
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
