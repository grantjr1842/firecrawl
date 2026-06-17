import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {
      entry: [
        "src/services/worker/**/*.ts",
        "src/services/**/*-worker.ts",
        "src/**/*.test.ts",
        "src/__tests__/**/*.ts",
      ],
      project: ["src/**/*.ts"],
    },
  },
  ignore: [
    "native/**",
    "src/scraper/scrapeURL/engines/fire-engine/branding-script/**",
  ],
  ignoreDependencies: ["undici-types", "stripe", "tls-client"],
  // The antibot framework exposes public classes/types that are
  // only consumed via the safeFetch path at runtime (knip can't
  // see the dynamic require() / class instantiation pattern). The
  // wire surface is documented in SELF_HOST.md under "Anti-bot
  // tiered router" and the test suite (src/__tests__/lib/antibot/)
  // exercises the public API directly.
  ignoreExportsUsedInFile: true,
};

export default config;
