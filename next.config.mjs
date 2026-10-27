const isProd = process.env.NODE_ENV === "production";

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  experimental: {
    // Admin uploads go through server actions. For large videos in production,
    // switch to direct-to-object-storage presigned uploads (see docs/ARCHITECTURE.md).
    serverActions: { bodySizeLimit: "210mb" },
  },
  async headers() {
    const csp = [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      // Next.js needs inline scripts/styles; tighten with nonces before launch if desired.
      `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
