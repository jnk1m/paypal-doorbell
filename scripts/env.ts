// Load ANTHROPIC_API_KEY (and other settings) from a .env file without ever printing a value.
// Looks in $ENV_FILE, ./.env, and the main repo root's .env (the git common dir's parent), so it also works from a worktree.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { PaypalClient } from "../lib/pay/paypal.ts";

export function loadEnv(): { files: string[]; searched: string[] } {
  const searched: string[] = [];
  if (process.env.ENV_FILE) searched.push(process.env.ENV_FILE);
  searched.push(".env");
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    searched.push(`${dirname(common)}/.env`);
  } catch (err) {
    console.warn(`env: git could not locate the main repo root (${(err as Error).message.split("\n")[0]}); looked only in the paths above.`);
  }
  const files = [...new Set(searched)].filter((f) => existsSync(f));
  for (const f of files) process.loadEnvFile(f); // does not override variables that are already set
  return { files, searched };
}

// Upstash settings (KV_REST_API_URL, KV_REST_API_TOKEN) live in the main repo's .env.vercel, kept apart from .env so that
// `next dev` never picks up the shared database. Scripts that need Redis call this; $REDIS_ENV_FILE overrides the path.
export function loadRedisEnv(): void {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  const file = process.env.REDIS_ENV_FILE ?? `${dirname(common)}/.env.vercel`;
  if (existsSync(file)) process.loadEnvFile(file);
}

// The live token of the deployed shop (DOORBELL_LIVE_TOKEN) lives in the main repo's .env.live (gitignored), next to the other env files.
// $LIVE_ENV_FILE overrides the path. Returns the token; it is never printed.
export function liveToken(): string {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  const file = process.env.LIVE_ENV_FILE ?? `${dirname(common)}/.env.live`;
  if (existsSync(file)) process.loadEnvFile(file);
  const token = process.env.DOORBELL_LIVE_TOKEN;
  if (!token) throw new Error(`DOORBELL_LIVE_TOKEN is not set and ${file} does not provide it`);
  return token;
}

// The two Sandbox apps (plan 9.10): "dev" is the Default Application (PAYPAL_CLIENT_ID/SECRET, free to experiment on), "demo" is
// "Doorbell Demo" (PAYPAL_DEMO_CLIENT_ID/SECRET, app_id APP-4SF2883699350514P; its webhooks are frozen at the end of S2). The
// deployed site acts as the demo app: Vercel production holds the demo keys under the names PAYPAL_CLIENT_ID/SECRET.
export type App = "dev" | "demo";
export const DEMO_APP_ID = "APP-4SF2883699350514P";

export function appClient(app: App, opts: { timeoutMs?: number } = {}): PaypalClient {
  loadEnv();
  const env = app === "demo" ? { PAYPAL_CLIENT_ID: process.env.PAYPAL_DEMO_CLIENT_ID, PAYPAL_CLIENT_SECRET: process.env.PAYPAL_DEMO_CLIENT_SECRET } : process.env;
  return PaypalClient.fromEnv(env, opts);
}

// The record of the demo app's frozen webhooks. While this file exists, scripts/webhook.ts will not touch the demo app's webhooks.
export const FROZEN_FILE = new URL("../fixtures/demo-webhooks.frozen.json", import.meta.url).pathname;

export function requireAnthropicKey(script: string): void {
  const { files, searched } = loadEnv();
  if (process.env.ANTHROPIC_API_KEY) {
    console.log(`env: ANTHROPIC_API_KEY is set (from ${files.length ? files.join(", ") : "the shell environment"}).`);
    return;
  }
  console.error(`${script}: not run: ANTHROPIC_API_KEY is not set. Looked in: ${searched.join(", ")} (found: ${files.join(", ") || "none"}). Add ANTHROPIC_API_KEY=... to the main repo .env.`);
  process.exit(2);
}
