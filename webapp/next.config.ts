import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root: a sibling package-lock.json in the repo root would
  // otherwise make Next infer the wrong root and widen filesystem watching.
  turbopack: { root: __dirname },
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
