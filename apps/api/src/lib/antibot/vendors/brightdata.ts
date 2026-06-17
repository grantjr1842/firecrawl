// Bright Data anti-bot vendor adapter (stub)
//
// Bright Data (formerly Luminati) exposes a "super proxy" listening on a
// fixed host:port. Auth is via Basic auth in the proxy URL, with the
// session-id and optional geo / product encoded into the username.
//
// Username format (simplified):
//   <customer>-zone-<zone>-country-<geo>
//   -session-<sessionId>      (sticky session; omit for per-request rotation)
//
// This is a **foundation** stub. It builds well-formed URLs from
// config. Production-grade tuning (zone selection, country codes,
// per-product credentials, bandwidth alarms) is tracked separately in
// T1.1.

import type {
  VendorAdapter,
  VendorAdapterOptions,
  VendorBuildOptions,
  VendorCredentials,
} from "./types";

export const BRIGHTDATA_DEFAULT_HOST = "brd.superproxy.io";
export const BRIGHTDATA_DEFAULT_PORT = 22225;
export const BRIGHTDATA_DEFAULT_ZONE = "residential";

export class BrightDataVendorAdapter implements VendorAdapter {
  readonly id = "brightdata" as const;
  readonly label = "Bright Data";
  readonly defaultZone = BRIGHTDATA_DEFAULT_ZONE;

  validate(creds: VendorCredentials): void {
    if (!creds.username) {
      throw new Error(
        "BrightDataVendorAdapter: FIRECRAWL_BRIGHTDATA_USERNAME is required",
      );
    }
    if (!creds.password) {
      throw new Error(
        "BrightDataVendorAdapter: FIRECRAWL_BRIGHTDATA_PASSWORD is required",
      );
    }
    if (!creds.host) {
      throw new Error(
        "BrightDataVendorAdapter: resolved host is empty (set FIRECRAWL_BRIGHTDATA_HOST)",
      );
    }
  }

  buildProxyUrl(creds: VendorCredentials, opts: VendorBuildOptions): string {
    // We treat the `customer_id` part of the username as opaque — it is
    // whatever the operator configured in FIRECRAWL_BRIGHTDATA_USERNAME
    // (typically "<customerId>-zone-<zone>"). We append additional
    // session / geo tokens after a dash separator.
    const tokens: string[] = [creds.username];
    if (opts.geo) {
      tokens.push(`country-${opts.geo.toLowerCase()}`);
    }
    if (opts.sessionId) {
      tokens.push(`session-${opts.sessionId}`);
      // ANTI-BOT-6: Bright Data also accepts a `sesstime-<minutes>`
      // token to bound the sticky session lifetime. Mirror the
      // smartproxy adapter so both vendors honor the caller's TTL.
      if (opts.sessionTtlMs) {
        const minutes = Math.max(1, Math.ceil(opts.sessionTtlMs / 60_000));
        tokens.push(`sesstime-${minutes}`);
      }
    }
    const userInfo = tokens.join("-");
    return `http://${userInfo}:${creds.password}@${creds.host}:${creds.port}`;
  }
}

export function createBrightDataAdapter(
  opts: VendorAdapterOptions = {},
): VendorAdapter {
  return new BrightDataVendorAdapter();
}
