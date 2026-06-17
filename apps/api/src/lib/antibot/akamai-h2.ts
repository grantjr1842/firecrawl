// Akamai HTTP/2 fingerprinting dispatcher (stub)
import { Agent, fetch as undiciFetch } from "undici";
import type { AntiBotProvider } from "./types";
import { withSSRFGuard } from "../../scraper/scrapeURL/engines/utils/safeFetch";

/** Chrome 120's default H2 SETTINGS. */
export const CHROME_120_H2_SETTINGS = {
  headerTableSize: 65_536,
  enablePush: 0,
  maxConcurrentStreams: 1_000,
  initialWindowSize: 6_291_456,
  maxFrameSize: 16_384,
  maxHeaderListSize: 262_144,
} as const;

export interface AkamaiH2ProviderOptions {
  proxyUrl?: string;
  timeoutMs?: number;
  h2Settings?: Partial<typeof CHROME_120_H2_SETTINGS>;
  resetStreamOn403?: boolean;
}

interface UndiciConnectOptions {
  ALPNProtocols?: string[];
  [key: string]: unknown;
}

export class AkamaiH2Provider implements AntiBotProvider {
  readonly name = "akamai-h2";
  readonly tier = "akamai-h2" as const;
  private readonly agent: Agent;
  private readonly proxyUrl?: string;
  private readonly timeoutMs: number;
  private readonly h2Settings: typeof CHROME_120_H2_SETTINGS;

  constructor(opts: AkamaiH2ProviderOptions = {}) {
    this.proxyUrl = opts.proxyUrl;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.h2Settings = {
      ...CHROME_120_H2_SETTINGS,
      ...(opts.h2Settings ?? {}),
    };

    const connectOpts: UndiciConnectOptions = {
      ALPNProtocols: ["h2"],
      h2: {
        headerTableSize: this.h2Settings.headerTableSize,
        enablePush: this.h2Settings.enablePush,
        maxConcurrentStreams: this.h2Settings.maxConcurrentStreams,
        initialWindowSize: this.h2Settings.initialWindowSize,
        maxFrameSize: this.h2Settings.maxFrameSize,
        maxHeaderListSize: this.h2Settings.maxHeaderListSize,
      },
    };

    this.agent = withSSRFGuard(
      new Agent({
        connect: connectOpts as unknown as Agent.Options["connect"],
        bodyTimeout: this.timeoutMs,
        headersTimeout: this.timeoutMs,
      }),
    );
  }

  describe(): string {
    return (
      `akamai-h2 (Chrome120 H2 SETTINGS, streams=${this.h2Settings.maxConcurrentStreams}, ` +
      `window=${this.h2Settings.initialWindowSize})` +
      (this.proxyUrl ? " via proxy" : "")
    );
  }

  isAvailable(): boolean {
    return true;
  }

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    return undiciFetch(input as any, {
      ...(init as any),
      dispatcher: this.agent,
    }) as unknown as Response;
  }
}
