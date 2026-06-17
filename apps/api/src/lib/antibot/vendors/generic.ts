// Generic anti-bot vendor adapter
//
// Default adapter used when the operator has not specified a known
// vendor. It treats the configured URL as a single proxy URL and
// applies the existing residential session-rotation scheme
// (replace `@` with `-session-<id>@`). This preserves the historical
// behaviour of `ResidentialProxyProvider` for self-hosters using
// arbitrary residential vendors.

import type {
  VendorAdapter,
  VendorAdapterOptions,
  VendorBuildOptions,
  VendorCredentials,
} from "./types";

export class GenericVendorAdapter implements VendorAdapter {
  readonly id = "generic" as const;
  readonly label = "Generic residential";

  validate(_creds: VendorCredentials): void {
    // Generic adapter is permissive: empty creds are fine when the
    // operator is using an unauthenticated internal proxy.
  }

  buildProxyUrl(
    creds: VendorCredentials,
    opts: VendorBuildOptions,
  ): string {
    // The legacy residential provider stored everything in
    // `vendorUrl`; the adapter contract passes host/port/credentials
    // separately. For "generic" we still need a base URL to encode
    // the session-id into.
    //
    // Implementation note: we accept a `target` hint purely for parity
    // with other adapters; it is not used here.
    void opts;
    if (!creds.host) {
      throw new Error(
        "GenericVendorAdapter: host is required (set FIRECRAWL_PROXY_VENDOR_URL)",
      );
    }
    const user = creds.username
      ? creds.username + (opts.sessionId ? `-session-${opts.sessionId}` : "")
      : "";
    const auth = user ? `${user}:${creds.password ?? ""}@` : "";
    return `http://${auth}${creds.host}:${creds.port}`;
  }
}

export function createGenericAdapter(
  opts: VendorAdapterOptions = {},
): VendorAdapter {
  return new GenericVendorAdapter();
}
