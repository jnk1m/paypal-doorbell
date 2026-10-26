import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";
import { loadEnv } from "./scripts/env.ts";
import { API_HEADERS, SECURITY_HEADERS } from "./lib/web/headers.ts";

const config: NextConfig = {
  // lib/pay/toolkit.ts loads the toolkit with a dynamic import; keep it a plain Node dependency instead of bundling it.
  serverExternalPackages: ["@paypal/agent-toolkit"],
  agentRules: false, // do not let `next dev` write an AGENTS.md into the repo (project rules live in CLAUDE.md)
  poweredByHeader: false,
  // The cause step answers from recordings that lib/core/llm.ts reads from disk by hash, from the folder lib/run/recordings.ts names
  // (relative to process.cwd(), the project root of a deployed function); the file tracer cannot see such reads, so they are named here for
  // the shop's routes, one level of path for each glob (a single * does not cross a slash). GET /api/shop/snapshot/causes shows on a
  // deployed site whether they are found.
  outputFileTracingIncludes: { "/api/shop/*": ["./fixtures/recordings/*.json"], "/api/shop/snapshot/*": ["./fixtures/recordings/*.json"] },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      { source: "/api/:path*", headers: API_HEADERS },
    ];
  },
};

export default function nextConfig(phase: string): NextConfig {
  // `npm run dev` also finds the main repo's .env from a git worktree (the same lookup the scripts use). Values are never printed.
  if (phase === PHASE_DEVELOPMENT_SERVER) loadEnv();
  return config;
}
