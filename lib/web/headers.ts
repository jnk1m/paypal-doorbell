// Security headers for every response (plan 9.9, R13). next.config.ts applies them to all paths.
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
];

// API responses are per request and may carry per-session data: nothing may be cached by a CDN or a browser.
export const API_HEADERS: { key: string; value: string }[] = [{ key: "Cache-Control", value: "no-store" }];
