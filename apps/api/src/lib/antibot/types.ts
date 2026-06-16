// Anti-bot provider framework — types
//
// Defines the pluggable provider contract used by `lib/antibot/router.ts`
// to route outbound scrapes through tiered proxies.

export type AntiBotTier =
  | "datacenter"
  | "tls-fingerprint"
  | "akamai-h2"
  | "residential"
  | "tor";

export interface AntiBotProvider {
  readonly name: string;
  readonly tier: AntiBotTier;
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface AntiBotContext {
  provider: string | null;
  tried: Array<{
    provider: string;
    tier: AntiBotTier;
    status: number | string;
  }>;
  durationMs: number;
}

export function emptyContext(): AntiBotContext {
  return { provider: null, tried: [], durationMs: 0 };
}
