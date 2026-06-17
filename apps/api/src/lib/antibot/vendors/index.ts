// Anti-bot vendor adapter factory
//
// The `AntiBotRouter` calls `createVendorAdapter(...)` once at config
// load time. The returned adapter is then handed to
// `ResidentialProxyProvider` which uses it to build per-request proxy
// URLs.
//
// Selection rules:
//   - If `FIRECRAWL_ANTIBOT_VENDOR` is "brightdata" → Bright Data
//   - If `FIRECRAWL_ANTIBOT_VENDOR` is "smartproxy" → Smartproxy
//   - Otherwise → "generic" (default; preserves existing behaviour)
//
// Credentials are sourced from the matched vendor's env vars
// (FIRECRAWL_BRIGHTDATA_USERNAME / _PASSWORD / _HOST, etc.).

import {
  BRIGHTDATA_DEFAULT_HOST,
  BRIGHTDATA_DEFAULT_PORT,
  createBrightDataAdapter,
} from "./brightdata";
import {
  SMARTPROXY_DEFAULT_HOST,
  SMARTPROXY_DEFAULT_PORT,
  createSmartproxyAdapter,
} from "./smartproxy";
import { createGenericAdapter } from "./generic";
import type {
  VendorAdapter,
  VendorAdapterOptions,
  VendorCredentials,
  VendorId,
} from "./types";

export interface VendorConfig {
  vendor: VendorId;
  username?: string;
  password?: string;
  host?: string;
  port?: number;
  zone?: string;
  product?: string;
}

export interface CreateVendorAdapterOptions {
  vendor: string | undefined;
  config: VendorConfig;
}

/**
 * Resolve the credentials for a known vendor. The host/port default to
 * vendor-specific values when the operator did not override them.
 */
export function resolveVendorCredentials(
  vendor: VendorId,
  cfg: VendorConfig,
): VendorCredentials {
  switch (vendor) {
    case "brightdata":
      return {
        username: cfg.username ?? "",
        password: cfg.password ?? "",
        host: cfg.host ?? BRIGHTDATA_DEFAULT_HOST,
        port: cfg.port ?? BRIGHTDATA_DEFAULT_PORT,
      };
    case "smartproxy":
      return {
        username: cfg.username ?? "",
        password: cfg.password ?? "",
        host: cfg.host ?? SMARTPROXY_DEFAULT_HOST,
        port: cfg.port ?? SMARTPROXY_DEFAULT_PORT,
      };
    case "generic":
    default:
      return {
        username: cfg.username ?? "",
        password: cfg.password ?? "",
        host: cfg.host ?? "",
        port: cfg.port ?? 0,
      };
  }
}

function pickVendorId(raw: string | undefined): VendorId {
  const v = (raw ?? "").toLowerCase().trim();
  if (v === "brightdata" || v === "bright-data" || v === "luminati") {
    return "brightdata";
  }
  if (v === "smartproxy" || v === "smart-proxy") {
    return "smartproxy";
  }
  return "generic";
}

export function createVendorAdapter(
  opts: CreateVendorAdapterOptions,
): VendorAdapter {
  const vendor = pickVendorId(opts.vendor);
  const adapterOpts: VendorAdapterOptions = {
    username: opts.config.username,
    password: opts.config.password,
    host: opts.config.host,
    port: opts.config.port,
    zone: opts.config.zone,
    product: opts.config.product,
  };
  let adapter: VendorAdapter;
  switch (vendor) {
    case "brightdata":
      adapter = createBrightDataAdapter(adapterOpts);
      break;
    case "smartproxy":
      adapter = createSmartproxyAdapter(adapterOpts);
      break;
    case "generic":
    default:
      adapter = createGenericAdapter(adapterOpts);
      break;
  }
  const creds = resolveVendorCredentials(vendor, opts.config);
  adapter.validate(creds);
  return adapter;
}

export { resolveVendorCredentials as _resolveVendorCredentials };
export { pickVendorId as _pickVendorId };

export type { VendorAdapter, VendorId, VendorCredentials };
export {
  BrightDataVendorAdapter,
  BRIGHTDATA_DEFAULT_HOST,
  BRIGHTDATA_DEFAULT_PORT,
  createBrightDataAdapter,
} from "./brightdata";
export {
  SmartproxyVendorAdapter,
  SMARTPROXY_DEFAULT_HOST,
  SMARTPROXY_DEFAULT_PORT,
  SMARTPROXY_DEFAULT_STICKY_MINUTES,
  createSmartproxyAdapter,
} from "./smartproxy";
export { GenericVendorAdapter, createGenericAdapter } from "./generic";
