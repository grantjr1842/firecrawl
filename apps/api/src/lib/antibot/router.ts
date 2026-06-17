// Anti-bot tiered router
import { config } from "../../config";
import type { AntiBotContext, AntiBotProvider, AntiBotTier } from "./types";
import { emptyContext } from "./types";
import { DatacenterProxyProvider } from "./datacenter";
import { TorSocksProvider } from "./tor";
import { ResidentialProxyProvider } from "./residential";
import { TlsFingerprintProvider } from "./tls-fingerprint";
import { AkamaiH2Provider } from "./akamai-h2";
import {
  createVendorAdapter,
  resolveVendorCredentials,
  type VendorConfig,
} from "./vendors";
import { assertUrlNotInternal } from "../../scraper/scrapeURL/engines/utils/safeFetch";

const DEFAULT_TIERS: AntiBotTier[] = [
  "datacenter",
  "tls-fingerprint",
  "akamai-h2",
  "residential",
  "tor",
];
const DEFAULT_RETRY_STATUS = "403,429,503";

let _router: AntiBotRouter | null = null;

export function getAntiBotRouter(): AntiBotRouter {
  if (_router) return _router;
  _router = buildRouterFromConfig();
  return _router;
}

export function _resetAntiBotRouter(): void {
  _router = null;
}

function parseTiers(raw: string | undefined): AntiBotTier[] {
  if (!raw) return DEFAULT_TIERS;
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every(x => typeof x === "string") &&
      parsed.length > 0
    ) {
      return parsed as AntiBotTier[];
    }
  } catch {
    // fallthrough
  }
  return DEFAULT_TIERS;
}

function parseRetryStatuses(raw: string | undefined): Set<number> {
  const out = new Set<number>();
  const src = raw ?? DEFAULT_RETRY_STATUS;
  for (const piece of src.split(",")) {
    const n = Number(piece.trim());
    if (!Number.isNaN(n) && n > 0) out.add(n);
  }
  return out.size > 0 ? out : new Set([403, 429, 503]);
}

function buildResidentialProviderFromConfig(): ResidentialProxyProvider {
  const vendorRaw = config.FIRECRAWL_ANTIBOT_VENDOR;

  if (vendorRaw && vendorRaw !== "generic") {
    // Vendor-adapter path: pull credentials from the matched vendor's
    // env vars, then hand the adapter to the residential provider.
    const vendorCfg: VendorConfig = readVendorConfigFromEnv(vendorRaw);
    try {
      const adapter = createVendorAdapter({
        vendor: vendorRaw,
        config: vendorCfg,
      });
      const creds = resolveVendorCredentials(adapter.id, vendorCfg);
      return new ResidentialProxyProvider({
        vendorAdapter: adapter,
        vendorCredentials: creds,
        rotate: config.FIRECRAWL_PROXY_VENDOR_ROTATE ?? true,
        ...(config.FIRECRAWL_ANTIBOT_VENDOR_GEO
          ? { geo: config.FIRECRAWL_ANTIBOT_VENDOR_GEO }
          : {}),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[antibot] vendor adapter "${vendorRaw}" could not be initialized (${(err as Error).message}). ` +
          "Falling back to the generic URL-based provider.",
      );
    }
  }

  // Generic / legacy path.
  return new ResidentialProxyProvider({
    vendorUrl: config.FIRECRAWL_PROXY_VENDOR_URL,
    rotate: config.FIRECRAWL_PROXY_VENDOR_ROTATE ?? true,
  });
}

function readVendorConfigFromEnv(
  vendor: "brightdata" | "smartproxy",
): VendorConfig {
  if (vendor === "brightdata") {
    return {
      vendor: "brightdata",
      username: config.FIRECRAWL_BRIGHTDATA_USERNAME,
      password: config.FIRECRAWL_BRIGHTDATA_PASSWORD,
      host: config.FIRECRAWL_BRIGHTDATA_HOST,
      port: config.FIRECRAWL_BRIGHTDATA_PORT,
    };
  }
  return {
    vendor: "smartproxy",
    username: config.FIRECRAWL_SMARTPROXY_USERNAME,
    password: config.FIRECRAWL_SMARTPROXY_PASSWORD,
    host: config.FIRECRAWL_SMARTPROXY_HOST,
    port: config.FIRECRAWL_SMARTPROXY_PORT,
  };
}

export function buildRouterFromConfig(): AntiBotRouter {
  const tiers = parseTiers(config.FIRECRAWL_ANTIBOT_TIERS);
  const retryStatuses = parseRetryStatuses(
    config.FIRECRAWL_ANTIBOT_RETRY_ON_STATUS,
  );
  const providers: AntiBotProvider[] = [];

  for (const tier of tiers) {
    if (tier === "datacenter" && config.PROXY_SERVER) {
      providers.push(
        new DatacenterProxyProvider({
          proxyServer: config.PROXY_SERVER,
          proxyUsername: config.PROXY_USERNAME,
          proxyPassword: config.PROXY_PASSWORD,
        }),
      );
    } else if (
      tier === "tls-fingerprint" &&
      config.FIRECRAWL_TLS_FINGERPRINT_ENABLED
    ) {
      const fpProvider = new TlsFingerprintProvider({
        fingerprint: config.FIRECRAWL_TLS_FINGERPRINT,
      });
      if (fpProvider.isAvailable()) {
        providers.push(fpProvider);
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          "[antibot] FIRECRAWL_TLS_FINGERPRINT_ENABLED=true but the " +
            "`tls-client` package is not installed — skipping the " +
            "tls-fingerprint tier. Run `pnpm install --include=optional` " +
            "in apps/api to enable it.",
        );
      }
    } else if (tier === "akamai-h2" && config.FIRECRAWL_AKAMAI_H2_ENABLED) {
      providers.push(
        new AkamaiH2Provider({
          timeoutMs: 30_000,
        }),
      );
    } else if (tier === "residential" && (config.FIRECRAWL_PROXY_VENDOR_URL || config.FIRECRAWL_ANTIBOT_VENDOR)) {
      providers.push(
        buildResidentialProviderFromConfig(),
      );
    } else if (tier === "tor" && config.FIRECRAWL_TOR_SOCKS_URL) {
      providers.push(
        new TorSocksProvider({
          socksUrl: config.FIRECRAWL_TOR_SOCKS_URL,
        }),
      );
    }
  }

  return new AntiBotRouter(providers, retryStatuses);
}

export class AntiBotRouter {
  readonly providers: ReadonlyArray<AntiBotProvider>;
  readonly retryStatuses: ReadonlySet<number>;

  constructor(
    providers: AntiBotProvider[],
    retryStatuses: Set<number> = new Set([403, 429, 503]),
  ) {
    this.providers = providers;
    this.retryStatuses = retryStatuses;
  }

  isEnabled(): boolean {
    return this.providers.length > 0;
  }

  async fetchWithContext(
    input: string | URL,
    init: RequestInit = {},
    options: { scopeKey?: string } = {},
  ): Promise<{ response: Response; context: AntiBotContext }> {
    const ctx = emptyContext();
    const start = Date.now();

    if (!this.isEnabled()) {
      ctx.durationMs = Date.now() - start;
      return {
        response: new Response(null, { status: 599 }),
        context: ctx,
      };
    }

    // SEC-2026-01: belt-and-braces pre-flight. The per-provider
    // dispatchers (datacenter/residential/tor/akamai-h2) already
    // attach a connect-hook that destroys sockets dialing private IPs,
    // and tls-fingerprint pre-resolves the hostname in its own fetch
    // path. We also pre-check the URL here so a DNS rebinding race
    // (resolve-public, dial-private) is caught before any tier is
    // allowed to issue a request.
    try {
      await assertUrlNotInternal(input);
    } catch (err) {
      ctx.durationMs = Date.now() - start;
      const body = JSON.stringify({
        error:
          "Antibot request blocked: URL resolves to a private / " +
          "loopback / link-local address. If you are running self-hosted " +
          "and need to target internal services, set ALLOW_LOCAL_WEBHOOKS=true.",
      });
      return {
        response: new Response(body, {
          status: 599,
          statusText: "AntibotSSRFBlocked",
          headers: { "content-type": "application/json" },
        }),
        context: ctx,
      };
    }

    for (const provider of this.providers) {
      try {
        // ANTI-BOT-6: forward the optional scope key (e.g. crawl id)
        // to the residential provider so sticky-session scoping works
        // for the configured `stickyScope`. Other providers ignore
        // the 3rd arg via the AntiBotProvider interface; we use a
        // runtime length check to keep the call site type-safe.
        const fetchFn = provider.fetch as (
          i: string | URL,
          init: RequestInit,
          fetchOpts?: { scopeKey?: string },
        ) => Promise<Response>;
        const response =
          options.scopeKey && provider.tier === "residential"
            ? await fetchFn.call(provider, input, init, {
                scopeKey: options.scopeKey,
              })
            : await provider.fetch(input, init);
        const status = response.status;
        ctx.tried.push({
          provider: provider.name,
          tier: provider.tier,
          status,
        });
        if (
          this.retryStatuses.has(status) &&
          provider !== this.providers[this.providers.length - 1]
        ) {
          continue;
        }
        ctx.provider = provider.name;
        ctx.durationMs = Date.now() - start;
        return { response, context: ctx };
      } catch (err) {
        ctx.tried.push({
          provider: provider.name,
          tier: provider.tier,
          status: "error",
        });
        if (provider === this.providers[this.providers.length - 1]) {
          break;
        }
      }
    }

    const triedSummary = ctx.tried
      .map(t => `${t.provider}:${t.status}`)
      .join(",");
    const body = JSON.stringify({
      error:
        "All antibot providers failed (see `tried` for the route). " +
        "If you are running self-hosted, supply at least one of " +
        "FIRECRAWL_TOR_SOCKS_URL, FIRECRAWL_PROXY_VENDOR_URL, " +
        "FIRECRAWL_TLS_FINGERPRINT_ENABLED, FIRECRAWL_AKAMAI_H2_ENABLED, " +
        "or PROXY_SERVER to enable tiered fallback.",
      tried: ctx.tried,
    });
    ctx.durationMs = Date.now() - start;
    return {
      response: new Response(body, {
        status: 599,
        statusText: `AntibotExhausted: ${triedSummary}`,
        headers: { "content-type": "application/json" },
      }),
      context: ctx,
    };
  }
}
