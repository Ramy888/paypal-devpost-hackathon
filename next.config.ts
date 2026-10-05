import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // AG Studio keeps its API on the instance from the first mount; strict mode's
  // dev-only double mount leaves us holding a destroyed instance.
  reactStrictMode: false,
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
