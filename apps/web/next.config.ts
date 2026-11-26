import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  output: "standalone",
  // Monorepo: tracing vanaf de root, zodat packages/* in de standalone-build komen.
  outputFileTracingRoot: join(here, "../.."),
  transpilePackages: ["@panel/api", "@panel/db"],
  poweredByHeader: false,
};

export default config;
