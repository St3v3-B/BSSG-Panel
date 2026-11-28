import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = dirname(fileURLToPath(import.meta.url));

const dev = process.env.NODE_ENV !== "production";

/**
 * CSP voor Next (inline bootstrap-scripts, dus 'unsafe-inline' zonder nonce) en Monaco (meegeleverd onder
 * /monaco/vs, zie copy-monaco.mjs; workers als module-worker van 'self', blob: voor oudere Monaco-paden). connect-src staat https:/wss: toe omdat up-/downloads en de
 * console-websocket naar de node-FQDN gaan (een ander domein dan het panel).
 */
export const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' https: wss:${dev ? " ws:" : ""}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const config: NextConfig = {
  output: "standalone",
  // Monorepo: tracing vanaf de root, zodat packages/* in de standalone-build komen.
  outputFileTracingRoot: join(here, "../.."),
  transpilePackages: ["@panel/api", "@panel/db"],
  poweredByHeader: false,
  // Alleen `next dev`: ook via 127.0.0.1 openen (WSL, testomgevingen); anders blokkeert Next de dev-bronnen en hydrateert de pagina niet.
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
