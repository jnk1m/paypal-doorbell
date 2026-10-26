// Manage webhooks on a Sandbox app. Writes (register, delete) only ever touch that Sandbox app.
//   npx tsx scripts/webhook.ts [--app dev|demo] list
//   npx tsx scripts/webhook.ts [--app dev|demo] register <https url> [--types PAYMENT.CAPTURE.COMPLETED,PAYMENT.CAPTURE.REFUNDED]
//   npx tsx scripts/webhook.ts [--app dev|demo] delete <webhook id>
// --app dev (default) is the Default Application, PAYPAL_CLIENT_ID/SECRET. --app demo is "Doorbell Demo", PAYPAL_DEMO_CLIENT_ID/SECRET.
// Without --types a webhook subscribes to what the witness needs (PAYMENT.CAPTURE.*, PAYMENT.AUTHORIZATION.*, CHECKOUT.ORDER.*).
// Once fixtures/demo-webhooks.frozen.json exists the demo app's webhooks are frozen (plan 9.10): this script refuses to change them.
import { existsSync } from "node:fs";
import { PaypalClient } from "../lib/pay/paypal.ts";
import { appClient, FROZEN_FILE, loadEnv } from "./env.ts";

const WITNESS_EVENTS = /^(PAYMENT\.CAPTURE\.|PAYMENT\.AUTHORIZATION\.|CHECKOUT\.ORDER\.)/;

interface Webhook {
  id: string;
  url: string;
  event_types: { name: string }[];
}

loadEnv();
const args = process.argv.slice(2);
const take = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const app = take("--app") ?? "dev";
if (app !== "dev" && app !== "demo") throw new Error(`--app must be dev or demo, got ${app}`);
const typesArg = take("--types");
const [command, arg] = args;
const client: PaypalClient = appClient(app);

async function list(): Promise<Webhook[]> {
  const r = await client.request<{ webhooks?: Webhook[] }>("list webhooks", "GET", "/v1/notifications/webhooks");
  return r.webhooks ?? [];
}

function refuseIfFrozen(): void {
  if (app === "demo" && existsSync(FROZEN_FILE)) throw new Error(`the demo app's webhooks are frozen (${FROZEN_FILE} exists): not editing them. Unfreezing is a decision, not a flag.`);
}

if (command === "list") {
  const hooks = await list();
  console.log(`${hooks.length} webhook(s) on the ${app} Sandbox app (the limit is 10)`);
  for (const h of hooks) console.log(`${h.id}  ${h.url}  ${h.event_types.length} event types`);
} else if (command === "register") {
  refuseIfFrozen();
  if (!arg?.startsWith("https://")) throw new Error("usage: webhook.ts [--app dev|demo] register https://<host>/<path> [--types A,B]");
  const existing = (await list()).find((h) => h.url === arg);
  if (existing) throw new Error(`a webhook for ${arg} already exists on the ${app} app: ${existing.id}`);
  const known = (await client.request<{ event_types: { name: string }[] }>("list event types", "GET", "/v1/notifications/webhooks-event-types")).event_types.map((t) => t.name);
  const types = typesArg ? typesArg.split(",") : known.filter((n) => WITNESS_EVENTS.test(n));
  const unknown = types.filter((t) => !known.includes(t));
  if (unknown.length) throw new Error(`event types PayPal does not list: ${unknown.join(", ")}`);
  const created = await client.request<Webhook>("register webhook", "POST", "/v1/notifications/webhooks", { body: { url: arg, event_types: types.map((name) => ({ name })) } });
  console.log(`registered ${created.id} on the ${app} app -> ${created.url} (${created.event_types.length} event types: ${created.event_types.map((t) => t.name).join(", ")})`);
  console.log(`at ${new Date().toISOString()}. PayPal can lose events for the first minutes after a registration (measured, cause unknown); wait before counting deliveries.`);
} else if (command === "delete") {
  refuseIfFrozen();
  if (!arg) throw new Error("usage: webhook.ts [--app dev|demo] delete <id>");
  await client.request("delete webhook", "DELETE", `/v1/notifications/webhooks/${arg}`);
  console.log(`deleted ${arg} from the ${app} app`);
} else {
  throw new Error("usage: webhook.ts [--app dev|demo] list | register <url> [--types A,B] | delete <id>");
}
