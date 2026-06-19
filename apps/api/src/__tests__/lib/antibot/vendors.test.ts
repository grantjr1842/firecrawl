// T1.1 (post-ultracode item #16): vendor adapter unit tests
//
// Verifies the Bright Data, Smartproxy, and Generic adapters produce
// well-formed proxy URLs, validate credentials, and round-trip through
// the factory. These are pure-logic tests; they do not hit the network.

import { describe, it, expect } from "vitest";
import {
  createVendorAdapter,
  resolveVendorCredentials,
  _pickVendorId,
} from "../../../lib/antibot/vendors";
import {
  BrightDataVendorAdapter,
  BRIGHTDATA_DEFAULT_HOST,
  BRIGHTDATA_DEFAULT_PORT,
} from "../../../lib/antibot/vendors/brightdata";
import {
  SmartproxyVendorAdapter,
  SMARTPROXY_DEFAULT_HOST,
  SMARTPROXY_DEFAULT_PORT,
} from "../../../lib/antibot/vendors/smartproxy";
import { GenericVendorAdapter } from "../../../lib/antibot/vendors/generic";
import { ResidentialProxyProvider } from "../../../lib/antibot/residential";

const BRIGHT_CREDS = {
  username: "brd-customer-1-zone-residential",
  password: "brdpass",
  host: BRIGHTDATA_DEFAULT_HOST,
  port: BRIGHTDATA_DEFAULT_PORT,
};

const SMART_CREDS = {
  username: "sp-user-1",
  password: "sppass",
  host: SMARTPROXY_DEFAULT_HOST,
  port: SMARTPROXY_DEFAULT_PORT,
};

describe("T1.1: vendor adapter factory", () => {
  it("picks Bright Data for `brightdata`, `bright-data`, and `luminati` aliases", () => {
    expect(_pickVendorId("brightdata")).toBe("brightdata");
    expect(_pickVendorId("Bright-Data")).toBe("brightdata");
    expect(_pickVendorId("luminati")).toBe("brightdata");
  });

  it("picks Smartproxy for `smartproxy` and `smart-proxy` aliases", () => {
    expect(_pickVendorId("smartproxy")).toBe("smartproxy");
    expect(_pickVendorId("Smart-Proxy")).toBe("smartproxy");
  });

  it("falls back to `generic` for unknown / empty vendors", () => {
    expect(_pickVendorId(undefined)).toBe("generic");
    expect(_pickVendorId("")).toBe("generic");
    expect(_pickVendorId("some-other-vendor")).toBe("generic");
  });

  it("createVendorAdapter returns a BrightData adapter for vendor=brightdata", () => {
    const adapter = createVendorAdapter({
      vendor: "brightdata",
      config: {
        vendor: "brightdata",
        username: BRIGHT_CREDS.username,
        password: BRIGHT_CREDS.password,
      },
    });
    expect(adapter.id).toBe("brightdata");
    expect(adapter.label).toBe("Bright Data");
  });

  it("createVendorAdapter returns a Smartproxy adapter for vendor=smartproxy", () => {
    const adapter = createVendorAdapter({
      vendor: "smartproxy",
      config: {
        vendor: "smartproxy",
        username: SMART_CREDS.username,
        password: SMART_CREDS.password,
      },
    });
    expect(adapter.id).toBe("smartproxy");
    expect(adapter.label).toBe("Smartproxy");
  });

  it("createVendorAdapter returns a Generic adapter for vendor=generic", () => {
    const adapter = createVendorAdapter({
      vendor: "generic",
      config: { vendor: "generic", host: "residential.example.com", port: 9000 },
    });
    expect(adapter.id).toBe("generic");
  });

  it("resolveVendorCredentials applies vendor defaults when host/port omitted", () => {
    const creds = resolveVendorCredentials("brightdata", {
      vendor: "brightdata",
      username: "u",
      password: "p",
    });
    expect(creds.host).toBe(BRIGHTDATA_DEFAULT_HOST);
    expect(creds.port).toBe(BRIGHTDATA_DEFAULT_PORT);
  });

  it("createVendorAdapter throws when vendor=brightdata has no username", () => {
    expect(() =>
      createVendorAdapter({
        vendor: "brightdata",
        config: { vendor: "brightdata" },
      }),
    ).toThrow(/BRIGHTDATA_USERNAME/);
  });
});

describe("T1.1: BrightDataVendorAdapter URL construction", () => {
  const adapter = new BrightDataVendorAdapter();

  it("emits http://<user>:<pass>@<host>:<port> with no session/geo", () => {
    const url = adapter.buildProxyUrl(BRIGHT_CREDS, {
      target: "https://example.com/",
    });
    expect(url).toBe(
      `http://${BRIGHT_CREDS.username}:${BRIGHT_CREDS.password}@${BRIGHT_CREDS.host}:${BRIGHT_CREDS.port}`,
    );
  });

  it("appends -session-<id> when a sessionId is supplied", () => {
    const url = adapter.buildProxyUrl(BRIGHT_CREDS, {
      target: "https://example.com/",
      sessionId: "abc12345",
    });
    expect(url).toContain("-session-abc12345");
    expect(url).toMatch(new RegExp(`@${BRIGHT_CREDS.host}:${BRIGHT_CREDS.port}$`));
  });

  it("appends -country-<geo> when geo is supplied", () => {
    const url = adapter.buildProxyUrl(BRIGHT_CREDS, {
      target: "https://example.com/",
      geo: "US",
    });
    expect(url).toContain("-country-us");
  });

  it("appends both -country-<geo> and -session-<id> in the correct order", () => {
    const url = adapter.buildProxyUrl(BRIGHT_CREDS, {
      target: "https://example.com/",
      geo: "de",
      sessionId: "zz9999",
    });
    expect(url).toContain("country-de");
    expect(url).toContain("session-zz9999");
    expect(url).toMatch(/-country-de-session-zz9999:/);
  });

  it("validate() throws when username is missing", () => {
    expect(() =>
      adapter.validate({ ...BRIGHT_CREDS, username: "" }),
    ).toThrow(/BRIGHTDATA_USERNAME/);
  });

  it("validate() throws when password is missing", () => {
    expect(() =>
      adapter.validate({ ...BRIGHT_CREDS, password: "" }),
    ).toThrow(/BRIGHTDATA_PASSWORD/);
  });
});

describe("T1.1: SmartproxyVendorAdapter URL construction", () => {
  const adapter = new SmartproxyVendorAdapter();

  it("emits http://<user>:<pass>@<host>:<port> with no session/geo", () => {
    const url = adapter.buildProxyUrl(SMART_CREDS, {
      target: "https://example.com/",
    });
    expect(url).toBe(
      `http://${SMART_CREDS.username}:${SMART_CREDS.password}@${SMART_CREDS.host}:${SMART_CREDS.port}`,
    );
  });

  it("appends -session-<id>-sesstime-<minutes> when a sessionId is supplied", () => {
    const url = adapter.buildProxyUrl(SMART_CREDS, {
      target: "https://example.com/",
      sessionId: "sess42",
    });
    expect(url).toContain("-session-sess42-sesstime-");
  });

  it("appends -country-<geo> when geo is supplied", () => {
    const url = adapter.buildProxyUrl(SMART_CREDS, {
      target: "https://example.com/",
      geo: "GB",
    });
    expect(url).toContain("-country-gb");
  });

  it("validate() throws when username is missing", () => {
    expect(() =>
      adapter.validate({ ...SMART_CREDS, username: "" }),
    ).toThrow(/SMARTPROXY_USERNAME/);
  });
});

describe("SMARTPROXY-STICKY-MISSING-ENV: sticky-minutes env wiring", () => {
  const baseOpts = {
    target: "https://example.com/",
    sessionId: "sess42",
  };

  it("defaults to 10 minutes when no option is supplied", () => {
    const url = new SmartproxyVendorAdapter().buildProxyUrl(
      SMART_CREDS,
      baseOpts,
    );
    expect(url).toMatch(/-sesstime-10\b/);
  });

  it("honors explicit stickyMinutes from VendorAdapterOptions", () => {
    const url = new SmartproxyVendorAdapter({ stickyMinutes: 30 }).buildProxyUrl(
      SMART_CREDS,
      baseOpts,
    );
    expect(url).toMatch(/-sesstime-30\b/);
  });

  it("clamps stickyMinutes into [1, 1440] at construction", () => {
    expect(
      new SmartproxyVendorAdapter({ stickyMinutes: 0 }).buildProxyUrl(
        SMART_CREDS,
        baseOpts,
      ),
    ).toMatch(/-sesstime-1\b/);
    expect(
      new SmartproxyVendorAdapter({ stickyMinutes: -7 }).buildProxyUrl(
        SMART_CREDS,
        baseOpts,
      ),
    ).toMatch(/-sesstime-1\b/);
    expect(
      new SmartproxyVendorAdapter({ stickyMinutes: 5000 }).buildProxyUrl(
        SMART_CREDS,
        baseOpts,
      ),
    ).toMatch(/-sesstime-1440\b/);
    expect(
      new SmartproxyVendorAdapter({ stickyMinutes: 12.9 }).buildProxyUrl(
        SMART_CREDS,
        baseOpts,
      ),
    ).toMatch(/-sesstime-12\b/);
  });

  it("createVendorAdapter passes stickyMinutes through from VendorConfig", () => {
    const adapter = createVendorAdapter({
      vendor: "smartproxy",
      config: {
        vendor: "smartproxy",
        username: "sp-user-1",
        password: "sppass",
        host: SMARTPROXY_DEFAULT_HOST,
        port: SMARTPROXY_DEFAULT_PORT,
        stickyMinutes: 45,
      },
    });
    const url = adapter.buildProxyUrl(SMART_CREDS, baseOpts);
    expect(url).toMatch(/-sesstime-45\b/);
  });
});

describe("T1.1: GenericVendorAdapter URL construction", () => {
  const adapter = new GenericVendorAdapter();

  it("emits http://<user>:<pass>@<host>:<port> with no session", () => {
    const url = adapter.buildProxyUrl(
      { username: "u", password: "p", host: "r.example.com", port: 9000 },
      { target: "https://example.com/" },
    );
    expect(url).toBe("http://u:p@r.example.com:9000");
  });

  it("appends -session-<id> to the username when sessionId is supplied", () => {
    const url = adapter.buildProxyUrl(
      { username: "u", password: "p", host: "r.example.com", port: 9000 },
      { target: "https://example.com/", sessionId: "sid" },
    );
    expect(url).toBe("http://u-session-sid:p@r.example.com:9000");
  });

  it("throws when host is missing", () => {
    expect(() =>
      adapter.buildProxyUrl(
        { username: "u", password: "p", host: "", port: 0 },
        { target: "https://example.com/" },
      ),
    ).toThrow(/host is required/);
  });

  it("validate() is permissive (does not throw on empty creds)", () => {
    expect(() =>
      adapter.validate({ username: "", password: "", host: "", port: 0 }),
    ).not.toThrow();
  });
});

describe("T1.1: ResidentialProxyProvider accepts a vendor adapter", () => {
  it("describe() returns the vendor label when an adapter is supplied", () => {
    const adapter = new BrightDataVendorAdapter();
    const p = new ResidentialProxyProvider({
      vendorAdapter: adapter,
      vendorCredentials: BRIGHT_CREDS,
      rotate: true,
    });
    expect(p.name).toBe("residential");
    expect(p.tier).toBe("residential");
    expect(p.describe()).toBe("Bright Data vendor adapter");
  });

  it("throws when vendorAdapter is supplied but vendorCredentials is missing", () => {
    const adapter = new BrightDataVendorAdapter();
    expect(
      () =>
        new ResidentialProxyProvider({
          vendorAdapter: adapter,
          rotate: true,
        }),
    ).toThrow(/vendorCredentials is required/);
  });

  it("legacy vendorUrl path still works (no vendorAdapter)", () => {
    const p = new ResidentialProxyProvider({
      vendorUrl: "http://u:p@r.example.com:10000",
      rotate: false,
    });
    expect(p.describe()).toBe("http://***@r.example.com:10000");
  });
});
