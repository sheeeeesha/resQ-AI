/**
 * @type {import('next').NextConfig}
 */

/*
 * The Content-Security-Policy is built here rather than in `vercel.json`
 * because `connect-src` has to name the API's origin, and that is only known
 * from `NEXT_PUBLIC_API_URL` at build time. A static config file cannot read
 * it, and the alternative — `connect-src *` — would leave the one directive
 * that matters for this app doing nothing.
 *
 * What the console actually talks to is short: its own origin, the API, and
 * OpenStreetMap's tile server. Anything else is a bug or an exfiltration.
 */
const apiOrigin = (() => {
  const raw = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000";
  try {
    return new URL(raw).origin;
  } catch {
    // A malformed value would otherwise produce a CSP that silently blocks
    // every API call, which looks like the API being down.
    throw new Error(
      `NEXT_PUBLIC_API_URL is not a valid URL: ${raw}\n` +
        `Expected something like https://api.example.in`,
    );
  }
})();

const csp = [
  "default-src 'self'",
  // Next injects inline bootstrap scripts; 'unsafe-inline' is required until
  // the app is built with a nonce-based setup.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Leaflet marker pins are inline SVG data URIs; tiles come from OSM.
  "img-src 'self' data: blob: https://tile.openstreetmap.org",
  `connect-src 'self' ${apiOrigin}`,
  "font-src 'self'",
  // A dispatch console has no reason to be framed, and framing it is how a
  // clickjacked confirmation happens.
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig = {
  // The schema package ships TypeScript source; Next compiles it with the app
  // so the console and the API validate against the identical contract rather
  // than two copies that can drift.
  transpilePackages: ["@resqai/schema"],
  reactStrictMode: true,

  // The console holds no secrets and renders nothing until an operator signs
  // in, so there is nothing to cache and nothing worth revalidating.
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
