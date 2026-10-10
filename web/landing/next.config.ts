import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  agentRules: false,
  transpilePackages: ["@sylox/ui"],
};

export default nextConfig;
