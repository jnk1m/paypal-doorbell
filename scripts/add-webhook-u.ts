// Registers webhook U on the demo app and writes it into the freeze record. This is a deliberate, logged update of the freeze (plan 5.6, 9.10):
// U is a second shop-like webhook that does NOT subscribe to PAYMENT.CAPTURE.REFUNDED, the "unsubscribed event type" case file's webhook.
// Registering it starts the blind stretch of 4-6 minutes that any registration does (F6); run it well before the case files are planted
// (11-05), so U is at least 24 hours old by then. scripts/webhook.ts still refuses demo-app writes; this script is the one allowed exception, once.
//   npx tsx scripts/add-webhook-u.ts          registers U, checks the other webhooks did not change, updates the record
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appClient, FROZEN_FILE } from "./env.ts";

const BASE = process.env.SHOP_URL ?? "https://paypal-doorbell.vercel.app";
const U_URL = `${BASE}/api/shop/case-u`;
const U_TYPES = ["PAYMENT.CAPTURE.COMPLETED"]; // everything the shop webhook S has, minus PAYMENT.CAPTURE.REFUNDED
const WHY = "S3: webhook U, the unsubscribed-event-type case file's webhook (subscribes to COMPLETED only, not REFUNDED)";

interface Frozen {
  frozenAt: string;
  app: { name: string; appId: string };
  webhooks: { id: string; url: string; eventTypes: string[] }[];
  updates?: { at: string; webhook: string; why: string }[];
}
interface Webhook {
  id: string;
  url: string;
  event_types: { name: string }[];
}

if (!existsSync(FROZEN_FILE)) throw new Error(`${FROZEN_FILE} does not exist: nothing to update`);
const record = JSON.parse(readFileSync(FROZEN_FILE, "utf8")) as Frozen;
if (record.webhooks.some((w) => w.url === U_URL)) throw new Error(`${U_URL} is already in the freeze record`);

const client = appClient("demo");
const list = async () => (await client.request<{ webhooks?: Webhook[] }>("list webhooks", "GET", "/v1/notifications/webhooks")).webhooks ?? [];
const before = await list();
if (before.length !== record.webhooks.length) throw new Error(`the demo app has ${before.length} webhook(s), the record ${record.webhooks.length}: run check-webhooks.ts first`);
if (before.length + 1 > 4) throw new Error("the plan keeps at most 4 demo-app webhooks");

const created = await client.request<Webhook>("register webhook U", "POST", "/v1/notifications/webhooks", { body: { url: U_URL, event_types: U_TYPES.map((name) => ({ name })) } });
const types = created.event_types.map((t) => t.name).sort();
if (types.includes("PAYMENT.CAPTURE.REFUNDED")) throw new Error(`webhook ${created.id} subscribes to PAYMENT.CAPTURE.REFUNDED; that is not U`);
console.log(`registered U ${created.id} -> ${created.url} (${types.join(", ")}) at ${new Date().toISOString()}`);

const after = await list();
for (const f of record.webhooks) {
  const w = after.find((a) => a.id === f.id);
  const same = w && w.url === f.url && JSON.stringify(w.event_types.map((t) => t.name).sort()) === JSON.stringify(f.eventTypes);
  if (!same) throw new Error(`webhook ${f.id} changed while U was being registered`);
}
record.webhooks.push({ id: created.id, url: created.url, eventTypes: types });
record.webhooks.sort((a, b) => a.url.localeCompare(b.url));
record.updates = [...(record.updates ?? []), { at: new Date().toISOString(), webhook: created.id, why: WHY }];
writeFileSync(FROZEN_FILE, `${JSON.stringify(record, null, 2)}\n`);
console.log(`freeze record updated: ${record.webhooks.length} webhooks (D, S and U). PayPal can lose events for the first minutes after a registration; no trials for 10 minutes.`);
