import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Firecrawl Admin",
  description: "Operator-facing admin panel for the Firecrawl cluster.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: "#0b0d10",
          color: "#e6e8eb",
        }}
      >
        <header
          style={{
            padding: "1rem 2rem",
            borderBottom: "1px solid #1f2329",
            display: "flex",
            alignItems: "center",
            gap: "1.5rem",
          }}
        >
          <strong>Firecrawl Admin</strong>
          <nav style={{ display: "flex", gap: "1rem" }}>
            <a href="/health" style={{ color: "#9aa3ad" }}>
              Health
            </a>
            <a href="/monitors" style={{ color: "#9aa3ad" }}>
              Monitors
            </a>
          </nav>
        </header>
        <main style={{ padding: "2rem" }}>{children}</main>
      </body>
    </html>
  );
}
