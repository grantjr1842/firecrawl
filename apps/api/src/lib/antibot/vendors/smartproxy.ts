// Smartproxy anti-bot vendor adapter (stub)
//
// Smartproxy exposes a residential gateway at fixed host:port. The
// username carries the customer id and (optionally) a session token for
// sticky sessions, the password is the operator's API key.
//
// Username format (simplified):
//   <customerId>-country-<geo>-session-<sessionId>-sesstime-<minutes>
//
// This is a **foundation** stub. Production-grade tuning (plan-based
// credentials, traffic budgets, geo failover) is tracked separately in
// T1.1.

import type {
  VendorAdapter,
  VendorAdapterOptions,
  VendorBuildOptions,
  VendorCredentials,
} from "./types";

export const SMARTPROXY_DEFAULT_HOST = "gate.smartproxy.com";
export const SMARTPROXY_DEFAULT_PORT = 7000;
export const SMARTPROXY_DEFAULT_STICKY_MINUTES = 10;

export class SmartproxyVendorAdapter implements VendorAdapter {
  readonly id = "smartproxy" as const;
  readonly label = "Smartproxy";
  private readonly stickyMinutes: number;

  constructor(opts: VendorAdapterOptions = {}) {
    // For now the sticky TTL is fixed; future work will surface it as
    // an env var (FIRECRAWL_SMARTPROXY_STICKY_MINUTES) once production
    // tuning lands.
    this.stickyMinutes = SMARTPROXY_DEFAULT_STICKY_MINUTES;
  }

  validate(creds: VendorCredentials): void {
    if (!creds.username) {
      throw new Error(
        "SmartproxyVendorAdapter: FIRECRAWL_SMARTPROXY_USERNAME is required",
      );
    }
    if (!creds.password) {
      throw new Error(
        "SmartproxyVendorAdapter: FIRECRAWL_SMARTPROXY_PASSWORD is required",
      );
    }
    if (!creds.host) {
      throw new Error(
        "SmartproxyVendorAdapter: resolved host is empty (set FIRECRAWL_SMARTPROXY_HOST)",
      );
    }
  }

  buildProxyUrl(
    creds: VendorCredentials,
    opts: VendorBuildOptions,
  ): string {
    // Smartproxy keeps the customer id intact and appends additional
    // tokens.  We do not modify or split creds.username; we just glue
    // tokens on after a dash separator.
    const tokens: string[] = [creds.username];
    if (opts.geo) {
      tokens.push(`country-${opts.geo.toLowerCase()}`);
    }
    if (opts.sessionId) {
      tokens.push(`session-${opts.sessionId}`);
      // ANTI-BOT-6: when the caller supplies a sessionTtlMs, convert
      // it to minutes and pin the vendor-side sticky window to match
      // the in-process agent cache TTL. Floor at 1 minute so a
      // sub-minute TTL still produces a valid `sesstime-N` token.
      const minutes = opts.sessionTtlMs
        ? Math.max(1, Math.ceil(opts.sessionTtlMs / 60_000))
        : this.stickyMinutes;
      tokens.push(`sesstime-${minutes}`);
    }
    const userInfo = tokens.join("-");
    return `http://${userInfo}:${creds.password}@${creds.host}:${creds.port}`;
  }
}

export function createSmartproxyAdapter(
  opts: VendorAdapterOptions = {},
): VendorAdapter {
  return new SmartproxyVendorAdapter(opts);
}
