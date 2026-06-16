// Datacenter proxy provider
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { AntiBotProvider } from "./types";

export interface DatacenterProviderOptions {
  proxyServer: string;
  proxyUsername?: string;
  proxyPassword?: string;
}

export class DatacenterProxyProvider implements AntiBotProvider {
  readonly name = "datacenter";
  readonly tier = "datacenter" as const;
  private readonly agent: ProxyAgent;
  private readonly proxyServer: string;

  constructor(opts: DatacenterProviderOptions) {
    this.proxyServer = opts.proxyServer;
    const uri = opts.proxyServer.includes("://")
      ? opts.proxyServer
      : "http://" + opts.proxyServer;
    const token = opts.proxyUsername
      ? `Basic ${Buffer.from(
          `${opts.proxyUsername}:${opts.proxyPassword ?? ""}`,
        ).toString("base64")}`
      : undefined;
    this.agent = new ProxyAgent({ uri, token });
  }

  describe(): string {
    return this.proxyServer;
  }

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    return undiciFetch(input as any, {
      ...(init as any),
      dispatcher: this.agent,
    }) as unknown as Response;
  }
}
