import type { Socket } from "net";
import { config } from "../../../../config";
import type { TLSSocket } from "tls";
import * as undici from "undici";
import { interceptors } from "undici";
import { CookieJar } from "tough-cookie";
import { cookie } from "http-cookie-agent/undici";
import IPAddr from "ipaddr.js";
import { lookup as dnsLookup } from "dns/promises";
export class InsecureConnectionError extends Error {
  constructor() {
    super("Connection violated security rules.");
  }
}

export function isIPPrivate(address: string): boolean {
  if (!IPAddr.isValid(address)) return false;

  const addr = IPAddr.parse(address);
  return addr.range() !== "unicast";
}

/**
 * SEC-2026-01: Resolve the hostname of `url` and reject the request if
 * any returned address falls into a private / loopback / link-local
 * range. Used as a DNS pre-flight by transport layers that do not
 * expose an undici dispatcher we can wrap (e.g. tls-client in
 * TlsFingerprintProvider) and as a belt-and-braces guard at the router
 * boundary in `lib/antibot/router.ts`.
 *
 * Throws an `InsecureConnectionError` on a hit so callers can
 * pattern-match on the same surface as the dispatcher-based guard.
 * If `ALLOW_LOCAL_WEBHOOKS` is set the check is bypassed (mirrors the
 * behavior of the connect-hook guard) so self-hosted deployments can
 * intentionally target internal services.
 */
export async function assertUrlNotInternal(
  input: string | URL,
): Promise<void> {
  if (config.ALLOW_LOCAL_WEBHOOKS === true) return;
  const url = typeof input === "string" ? input : input.toString();
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Unparseable URL — let the downstream call fail on its own.
    return;
  }
  if (!hostname) return;
  // Bare IP literal? No DNS needed.
  if (isIPPrivate(hostname)) {
    throw new InsecureConnectionError();
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    // Resolution failure is the request's problem, not ours.
    return;
  }
  for (const a of addresses) {
    if (isIPPrivate(a.address)) {
      throw new InsecureConnectionError();
    }
  }
}

function createBaseAgent(skipTlsVerification: boolean) {
  const baseAgent = config.PROXY_SERVER
    ? new undici.ProxyAgent({
        uri: config.PROXY_SERVER.includes("://")
          ? config.PROXY_SERVER
          : "http://" + config.PROXY_SERVER,
        token: config.PROXY_USERNAME
          ? `Basic ${Buffer.from(config.PROXY_USERNAME + ":" + (config.PROXY_PASSWORD ?? "")).toString("base64")}`
          : undefined,
        requestTls: {
          rejectUnauthorized: !skipTlsVerification, // Only bypass SSL verification if explicitly requested
        },
      })
    : new undici.Agent({
        connect: {
          rejectUnauthorized: !skipTlsVerification, // Only bypass SSL verification if explicitly requested
        },
      });

  // Add redirect interceptor for handling redirects
  return baseAgent.compose(interceptors.redirect({ maxRedirections: 5000 }));
}

function attachSecurityCheck(agent: undici.Dispatcher) {
  agent.on("connect", (_, targets) => {
    const client: undici.Client = targets.slice(-1)[0] as undici.Client;
    const socketSymbol = Object.getOwnPropertySymbols(client).find(
      x => x.description === "socket",
    )!;
    const socket: Socket | TLSSocket = (client as any)[socketSymbol];

    if (
      socket.remoteAddress &&
      isIPPrivate(socket.remoteAddress) &&
      config.ALLOW_LOCAL_WEBHOOKS !== true
    ) {
      socket.destroy(new InsecureConnectionError());
    }
  });
}

/**
 * Wraps the given undici dispatcher (e.g. ProxyAgent, Socks5ProxyAgent,
 * undici.Agent) with a connect-hook that destroys the socket whenever the
 * remote address resolves to a private / loopback / link-local range
 * (RFC1918, 169.254/16, 127/8, IPv6 ULA, etc.). Intended for use by
 * antibot providers (datacenter, residential, tor, akamai-h2,
 * tls-fingerprint) that build their own dispatchers and would otherwise
 * bypass the direct-fetch SSRF guard in `secureDispatcher`.
 *
 * SEC-2026-01: prior to this, the antibot path dialed internal targets
 * (cloud metadata 169.254.169.254, VPC ranges) without any private-IP
 * check, enabling exfiltration through the operator's outbound proxy.
 */
export function withSSRFGuard<T extends undici.Dispatcher>(dispatcher: T): T {
  attachSecurityCheck(dispatcher);
  return dispatcher;
}

// Dispatcher WITH cookie handling (for scraping - needs cookies for auth flows)
function makeSecureDispatcher(skipTlsVerification: boolean) {
  const baseAgent = createBaseAgent(skipTlsVerification);
  const cookieJar = new CookieJar();
  const agent = baseAgent.compose(cookie({ jar: cookieJar }));
  attachSecurityCheck(agent);
  return agent;
}

// Dispatcher WITHOUT cookie handling (for webhooks - avoids empty cookie header bug)
function makeSecureDispatcherNoCookies(skipTlsVerification: boolean) {
  const agent = createBaseAgent(skipTlsVerification);
  attachSecurityCheck(agent);
  return agent;
}

const secureDispatcher = makeSecureDispatcher(false);
const secureDispatcherSkipTlsVerification = makeSecureDispatcher(true);
const secureDispatcherNoCookies = makeSecureDispatcherNoCookies(false);
const secureDispatcherNoCookiesSkipTlsVerification =
  makeSecureDispatcherNoCookies(true);

export const getSecureDispatcher = (skipTlsVerification: boolean = false) =>
  skipTlsVerification ? secureDispatcherSkipTlsVerification : secureDispatcher;

// Use this for webhook delivery to avoid sending empty cookie headers
export const getSecureDispatcherNoCookies = (
  skipTlsVerification: boolean = false,
) =>
  skipTlsVerification
    ? secureDispatcherNoCookiesSkipTlsVerification
    : secureDispatcherNoCookies;
