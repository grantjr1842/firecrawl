/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The admin panel is an internal operator tool. We don't ship it to
  // public CDNs — it's always served by the same Kubernetes cluster that
  // runs the firecrawl-api. Therefore we can disable image optimization
  // (which would otherwise require pulling sharp at build time).
  images: { unoptimized: true },
  // The monorepo has a top-level tsconfig that Next sometimes picks up
  // via the workspace root; ignore those sibling apps so the type check
  // stays scoped to admin-panel.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  // Expose the admin-panel API key (if set) to the client runtime so
  // `lib/api.ts` can forward it on the `/v2/monitor/admin/list` call.
  // When unset, the panel falls back to a best-effort probe that
  // gracefully reports "controller unavailable".
  env: {
    NEXT_PUBLIC_ADMIN_PANEL_API_KEY: process.env.ADMIN_PANEL_API_KEY ?? "",
  },
};

export default nextConfig;
