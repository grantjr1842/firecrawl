// TLS fingerprint rotation provider
import { fetch as undiciFetch } from "undici";
import type { AntiBotProvider } from "./types";

export const SUPPORTED_TLS_FINGERPRINTS = [
  "chrome_120",
  "chrome_119",
  "firefox_120",
  "safari_16_0",
  "edge_101",
  "opera_85",
  "okhttp_4_10",
] as const;

export type TlsFingerprint = (typeof SUPPORTED_TLS_FINGERPRINTS)[number];

export const DEFAULT_ACCEPT_LANGUAGE: Record<TlsFingerprint, string> = {
  chrome_120: "en-US,en;q=0.9",
  chrome_119: "en-US,en;q=0.9",
  firefox_120: "en-US,en;q=0.5",
  safari_16_0: "en-US,en;q=0.9",
  edge_101: "en-US,en;q=0.9",
  opera_85: "en-US,en;q=0.9",
  okhttp_4_10: "en-US",
};

export interface TlsFingerprintProviderOptions {
  fingerprint?: TlsFingerprint | string;
  proxyUrl?: string;
  timeoutMs?: number;
}

interface TlsClientSession {
  destroy(): void;
  getCookies(url: string): Promise<string>;
}

type TlsClientRequestFn = (options: {
  sessionId?: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  proxy?: string;
}) => Promise<{
  status: number;
  body: string;
  headers: Record<string, string[]>;
}>;

type TlsClientCreateSessionFn = (
  clientIdentifier: string,
  options?: { proxy?: string; timeout?: number },
) => Promise<string>;

type TlsClientDestroySessionFn = (sessionId: string) => Promise<void>;

interface TlsClientModule {
  Session?: new (
    clientIdentifier: string,
    options?: {
      proxy?: string;
      timeout?: number;
    },
  ) => TlsClientSession;
  request?: TlsClientRequestFn;
  createSession?: TlsClientCreateSessionFn;
  destroySession?: TlsClientDestroySessionFn;
  defaultHeaders?: Record<string, string>;
}

let _tlsClientModule: TlsClientModule | null | undefined;

function loadTlsClient(): TlsClientModule | null {
  if (_tlsClientModule !== undefined) return _tlsClientModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _tlsClientModule = require("tls-client") as TlsClientModule;
  } catch {
    _tlsClientModule = null;
  }
  return _tlsClientModule;
}

export function _resetTlsClientCache(): void {
  _tlsClientModule = undefined;
}

export class TlsFingerprintProvider implements AntiBotProvider {
  readonly name = "tls-fingerprint";
  readonly tier = "tls-fingerprint" as const;
  readonly fingerprint: TlsFingerprint | string;
  private readonly proxyUrl?: string;
  private readonly timeoutMs: number;
  private readonly sessionId: string | null;

  constructor(opts: TlsFingerprintProviderOptions = {}) {
    this.fingerprint = opts.fingerprint ?? "chrome_120";
    this.proxyUrl = opts.proxyUrl;
    this.timeoutMs = opts.timeoutMs ?? 30_000;

    const mod = loadTlsClient();
    if (!mod) {
      this.sessionId = null;
      return;
    }
    if (mod.createSession) {
      this.sessionId = null;
      mod
        .createSession(this.fingerprint, {
          proxy: this.proxyUrl,
          timeout: this.timeoutMs,
        })
        .catch(() => {
          /* swallow */
        });
    } else {
      this.sessionId = null;
    }
  }

  describe(): string {
    return `tls-fingerprint:${this.fingerprint}${
      this.proxyUrl ? " (via proxy)" : ""
    }`;
  }

  isAvailable(): boolean {
    return loadTlsClient() !== null;
  }

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const mod = loadTlsClient();
    if (!mod) {
      throw new Error(
        "TlsFingerprintProvider: the `tls-client` npm package is not installed. " +
          "Run `pnpm install --include=optional` in apps/api to enable TLS " +
          "fingerprint rotation.",
      );
    }

    const url = typeof input === "string" ? input : input.toString();
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => (headers[k] = v));
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k] = v;
      } else {
        Object.assign(headers, init.headers);
      }
    }
    headers["user-agent"] =
      headers["user-agent"] ?? defaultUserAgentFor(this.fingerprint);
    headers["accept-language"] =
      headers["accept-language"] ?? defaultAcceptLanguageFor(this.fingerprint);

    let body: string | undefined;
    if (init.body) {
      body =
        typeof init.body === "string"
          ? init.body
          : init.body instanceof URLSearchParams
            ? init.body.toString()
            : init.body instanceof ArrayBuffer
              ? Buffer.from(init.body).toString("utf8")
              : (init.body as { toString(): string }).toString();
    }

    if (typeof mod.request === "function") {
      const requestFn = mod.request as TlsClientRequestFn;
      const res = await requestFn({
        url,
        method,
        headers,
        body,
        timeout: this.timeoutMs,
        proxy: this.proxyUrl,
      });
      return new Response(res.body, {
        status: res.status,
        headers: flattenHeaders(res.headers),
      });
    }

    if (
      typeof mod.Session === "function" &&
      typeof mod.createSession === "function" &&
      typeof mod.request === "function"
    ) {
      const createSession = mod.createSession as TlsClientCreateSessionFn;
      const requestFn = mod.request as TlsClientRequestFn;
      const destroySession = mod.destroySession as
        | TlsClientDestroySessionFn
        | undefined;
      const sessionId = await createSession(this.fingerprint, {
        proxy: this.proxyUrl,
        timeout: this.timeoutMs,
      });
      try {
        const res = await requestFn({
          sessionId,
          url,
          method,
          headers,
          body,
        });
        return new Response(res.body, {
          status: res.status,
          headers: flattenHeaders(res.headers),
        });
      } finally {
        if (destroySession) {
          destroySession(sessionId).catch(() => {});
        }
      }
    }

    throw new Error(
      "TlsFingerprintProvider: installed `tls-client` version is incompatible " +
        "with this provider. Please upgrade.",
    );
  }
}

function defaultUserAgentFor(fp: string): string {
  if (fp.startsWith("chrome_")) {
    return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  }
  if (fp.startsWith("edge_")) {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.64 Safari/537.36 Edg/101.0.1210.53";
  }
  if (fp.startsWith("opera_")) {
    return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/85.0.4341.60";
  }
  if (fp.startsWith("firefox_")) {
    return "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";
  }
  if (fp.startsWith("safari_")) {
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15";
  }
  if (fp.startsWith("okhttp_")) {
    return "okhttp/4.10.0";
  }
  return "Mozilla/5.0";
}

function defaultAcceptLanguageFor(fp: string): string {
  if (fp in DEFAULT_ACCEPT_LANGUAGE) {
    return DEFAULT_ACCEPT_LANGUAGE[fp as TlsFingerprint];
  }
  return "en-US,en;q=0.9";
}

function flattenHeaders(raw: Record<string, string[]> | undefined): Headers {
  const out = new Headers();
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) {
      for (const value of v) out.append(k, value);
    } else if (typeof v === "string") {
      out.set(k, v);
    }
  }
  return out;
}

void undiciFetch;
