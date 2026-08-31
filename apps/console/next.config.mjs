/** @type {import('next').NextConfig} */
const nextConfig = {
  // The schema package ships TypeScript source; Next compiles it with the app
  // so the console and the API validate against the identical contract rather
  // than two copies that can drift.
  transpilePackages: ["@resqai/schema"],
  reactStrictMode: true,
};

export default nextConfig;
