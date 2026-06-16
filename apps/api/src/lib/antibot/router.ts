// Anti-bot tiered router
import { config } from "../../config";
import type { AntiBotContext, AntiBotProvider, AntiBotTier } from "./types";
import { emptyContext } from "./types";
import { DatacenterProxyProvider } from "./datacenter";
import { TorSocksProvider } from "./tor";
import { ResidentialProxyProvider } from "./residential";
import { TlsFingerprintProvider } from "./tls-fingerprint";
import { AkamaiH2Provider } from "./akamai-h2";

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
    } else if (tier === "residential" && config.FIRECRAWL_PROXY_VENDOR_URL) {
      providers.push(
        new ResidentialProxyProvider({
          vendorUrl: config.FIRECRAWL_PROXY_VENDOR_URL,
          rotate: config.FIRECRAWL_PROXY_VENDOR_ROTATE ?? true,
        }),
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

    for (const provider of this.providers) {
      try {
        const response = await provider.fetch(input, init);
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
