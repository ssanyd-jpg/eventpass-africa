import withPWAInit from "next-pwa";
import withBundleAnalyzerInit from "@next/bundle-analyzer";

// Session 22 performance audit — `ANALYZE=true npm run build` opens the
// client/server/edge bundle treemaps in a browser tab; a plain build is
// completely unaffected (withBundleAnalyzer no-ops when disabled).
const withBundleAnalyzer = withBundleAnalyzerInit({
  enabled: process.env.ANALYZE === "true",
});

const withPWA = withPWAInit({
  dest: "public",
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === "development",
  cacheOnFrontEndNav: true,
  runtimeCaching: [
    {
      urlPattern: /^https:\/\/picsum\.photos\/.*/i,
      handler: "CacheFirst",
      options: {
        cacheName: "eventpass-africa-event-images",
        expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
      },
    },
    {
      // Gate-result videos (granted/denied, ScanResultOverlay). denied.mp4
      // sits just over next-pwa's default 2MB precache ceiling, so the
      // install-time precache sweep silently drops it — an explicit
      // CacheFirst runtime route has no such size limit instead: the first
      // grant and the first denial at a gate cache themselves on that
      // first view, then replay with zero network for the rest of the
      // event, same "works offline" guarantee the rest of this app makes.
      urlPattern: /\/scan-results\/.*\.mp4$/i,
      handler: "CacheFirst",
      options: {
        cacheName: "eventpass-africa-scan-result-media",
        expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
      },
    },
    {
      urlPattern: /\/api\/sync\/pull.*/i,
      handler: "NetworkFirst",
      options: {
        cacheName: "eventpass-africa-api-pull",
        networkTimeoutSeconds: 4,
        expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 },
      },
    },
    {
      urlPattern: /^\/(?!api).*/i,
      handler: "NetworkFirst",
      options: {
        cacheName: "eventpass-africa-pages",
        networkTimeoutSeconds: 3,
        expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 7 },
      },
    },
  ],
});

const csp = [
  "default-src 'self'",
  // next-pwa's auto-register script and Next's hydration runtime need inline/eval.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // picsum.photos redirects actual image fetches to its fastly.picsum.photos
  // CDN subdomain, so both need to be allowed, not just the apex domain.
  "img-src 'self' data: https://picsum.photos https://*.picsum.photos https://*.public.blob.vercel-storage.com",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // camera stays enabled for the gate-scanner's QR camera mode.
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default withBundleAnalyzer(withPWA(nextConfig));
