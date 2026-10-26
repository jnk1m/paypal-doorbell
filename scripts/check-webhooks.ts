// Compares the demo app's webhooks with the frozen record (plan 9.10, R28). Read-only: two GETs, no writes.
//   npx tsx scripts/check-webhooks.ts             exit 0 when they match, 1 when anything differs
//   npx tsx scripts/check-webhooks.ts --record    write the record from what the demo app has now (this is the freeze)
// The record (fixtures/demo-webhooks.frozen.json) holds each webhook's id, url and sorted event types. The demo app's webhooks must
// not be edited after it is written: a registration or change starts a blind stretch of 4-6 minutes in which PayPal loses events
// (F6, F7), and the case files depend on a quiet app. scripts/webhook.ts refuses demo-app writes while the record exists.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appClient, DEMO_APP_ID, FROZEN_FILE } from "./env.ts";

interface Frozen {
  frozenAt: string;
  app: { name: string; appId: string };
  webhooks: { id: string; url: string; eventTypes: string[] }[];
  updates?: { at: string; webhook: string; why: string }[]; // deliberate changes made after the freeze (scripts/add-webhook-u.ts)
}

const client = appClient("demo");
const live = (await client.request<{ webhooks?: { id: string; url: string; event_types: { name: string }[] }[] }>("list webhooks", "GET", "/v1/notifications/webhooks")).webhooks ?? [];
const current = live.map((w) => ({ id: w.id, url: w.url, eventTypes: w.event_types.map((t) => t.name).sort() })).sort((a, b) => a.url.localeCompare(b.url));

if (process.argv.includes("--record")) {
  if (existsSync(FROZEN_FILE)) throw new Error(`${FROZEN_FILE} already exists: the demo app is frozen. Replacing the record is unfreezing; do it on purpose, by hand.`);
  if (current.length > 4) throw new Error(`${current.length} webhooks on the demo app; the plan keeps at most 4`);
  const record: Frozen = { frozenAt: new Date().toISOString(), app: { name: "Doorbell Demo", appId: DEMO_APP_ID }, webhooks: current };
  writeFileSync(FROZEN_FILE, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`froze ${current.length} webhook(s) on the demo app: ${current.map((w) => `${w.id} ${new URL(w.url).pathname} (${w.eventTypes.length} types)`).join("; ")}`);
} else {
  const frozen = JSON.parse(readFileSync(FROZEN_FILE, "utf8")) as Frozen;
  const problems: string[] = [];
  if (current.length !== frozen.webhooks.length) problems.push(`the demo app has ${current.length} webhook(s), the record has ${frozen.webhooks.length}`);
  for (const f of frozen.webhooks) {
    const w = current.find((c) => c.id === f.id);
    if (!w) {
      problems.push(`${f.id} (${f.url}) is in the record and not on the demo app`);
      continue;
    }
    if (w.url !== f.url) problems.push(`${f.id}: url is ${w.url}, the record says ${f.url}`);
    const missing = f.eventTypes.filter((t) => !w.eventTypes.includes(t));
    const extra = w.eventTypes.filter((t) => !f.eventTypes.includes(t));
    if (missing.length) problems.push(`${f.id}: no longer subscribed to ${missing.join(", ")}`);
    if (extra.length) problems.push(`${f.id}: now also subscribed to ${extra.join(", ")}`);
  }
  for (const w of current) if (!frozen.webhooks.some((f) => f.id === w.id)) problems.push(`${w.id} (${w.url}) is on the demo app and not in the record`);
  if (problems.length) {
    console.error(`demo app webhooks differ from the record of ${frozen.frozenAt}:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`demo app webhooks match the record of ${frozen.frozenAt}: ${current.length} webhook(s), ${current.reduce((n, w) => n + w.eventTypes.length, 0)} event type subscriptions`);
}
