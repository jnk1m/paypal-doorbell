// Re-verifies deliveries the witness stored, now, with PayPal's verify endpoint, and reports their age: does a stored signature
// still verify hours or days later (plan assumption 6, F15)? Reads Redis, calls only POST /v1/notifications/verify-webhook-signature.
//   npx tsx scripts/reverify-stored.ts [--limit 400] [--webhook-id <D>] [--dev-webhook-id <D-dev>]
// A delivery is checked against the webhook it was stored for (slot D = the witness webhook, slot D-dev = the dev app's), and then against
// the other known one: before the demo app took over the witness slot (2026-10-19 03:59 UTC) deliveries for the dev app's webhook were
// stored under slot "D", so a single id would call them FAILURE for a reason that has nothing to do with age.
import { PaypalClient } from "../lib/pay/paypal.ts";
import { redisFromEnv } from "../lib/redis.ts";
import { parseEvent } from "../lib/witness/precheck.ts";
import type { AttemptEntry } from "../lib/witness/store.ts";
import { loadEnv, loadRedisEnv } from "./env.ts";

loadEnv();
loadRedisEnv();
const redis = redisFromEnv();
const arg = (name: string) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
const primary = process.env.PAYPAL_WITNESS_WEBHOOK_ID ?? arg("webhook-id");
const dev = process.env.PAYPAL_WITNESS_DEV_WEBHOOK_ID ?? arg("dev-webhook-id");
if (!redis) throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN are not set");
if (!primary) throw new Error("set PAYPAL_WITNESS_WEBHOOK_ID or pass --webhook-id <id> (the witness webhook)");
const limit = Number(arg("limit")) || 400;
const client = PaypalClient.fromEnv();

const keys: string[] = [];
let cursor: string | number = 0;
do {
  const [next, found]: [string, string[]] = await redis.scan(cursor, { match: "db:w:att:*", count: 500 });
  keys.push(...found);
  cursor = next;
} while (String(cursor) !== "0");

const rows: { ageHours: number; status: string; under: string }[] = [];
for (const key of keys) {
  const [raw] = await redis.lrange<string>(key, 0, 0);
  const entry = JSON.parse(String(raw)) as AttemptEntry;
  if (!entry.raw) continue;
  const parsed = parseEvent(entry.raw);
  if (!parsed.ok) continue;
  const ageHours = (Date.now() - Date.parse(entry.h.time)) / 3_600_000;
  const candidates = (entry.slot === "D-dev" ? [["D-dev", dev], ["D", primary]] : [["D", primary], ["D-dev", dev]]).filter((c): c is [string, string] => Boolean(c[1]));
  let status = "FAILURE";
  let under = "none";
  for (const [name, webhookId] of candidates) {
    try {
      const s = (await client.verifyWebhookSignature({ authAlgo: entry.h.algo, certUrl: entry.h.cert, transmissionId: entry.tid, transmissionSig: entry.h.sig, transmissionTime: entry.h.time, webhookId, webhookEvent: parsed.parsed.event })) ?? "no status";
      if (s === "SUCCESS") {
        status = s;
        under = name;
        break;
      }
    } catch (e) {
      status = e instanceof Error ? e.message : "error";
    }
  }
  rows.push({ ageHours, status, under });
  if (rows.length >= limit) break;
}
rows.sort((a, b) => a.ageHours - b.ageHours);
const byStatus = rows.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
const ok = rows.filter((r) => r.status === "SUCCESS");
const bad = rows.filter((r) => r.status !== "SUCCESS");
console.log(`re-verified ${rows.length} stored deliveries: ${JSON.stringify(byStatus)}; SUCCESS under slot D ${ok.filter((r) => r.under === "D").length}, under slot D-dev ${ok.filter((r) => r.under === "D-dev").length}`);
console.log(`age of the stored signatures: youngest ${rows[0]?.ageHours.toFixed(2)} h, oldest ${rows.at(-1)?.ageHours.toFixed(2)} h`);
console.log(`oldest that verified: ${ok.at(-1)?.ageHours.toFixed(2)} h; youngest that did not: ${bad[0] ? `${bad[0].ageHours.toFixed(2)} h` : "none"}`);
