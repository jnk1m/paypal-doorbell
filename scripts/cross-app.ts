// S2 measurement: do events made through one Sandbox app reach the webhooks of the other app, while both apps share one Sandbox
// business account? Creates card orders (and one refund) through the dev app and through the demo app, then reads what each webhook
// received: the witness record (slot D = the demo app's witness webhook, D-dev = the dev app's), the shop's reporter (the demo app's
// shop webhook S), and each app's own events list.
//   npx tsx scripts/cross-app.ts create [--n 4] [--out <file>]     makes the orders; wait about 4 minutes
//   npx tsx scripts/cross-app.ts collect <file>                    reads Redis and the events lists, prints the table
// The orders are mapped to a throwaway session, so that the shop's reporter records what S receives (a map entry, not a book).
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { PaypalClient } from "../lib/pay/paypal.ts";
import { SANDBOX_TEST_CARD } from "../lib/pay/paypal.ts";
import { redisFromEnv } from "../lib/redis.ts";
import { COMPLETED, REFUNDED } from "../lib/shop/events.ts";
import { summarizeReport } from "../lib/shop/reporter.ts";
import { RedisShopStore } from "../lib/shop/store.ts";
import { parseEvent } from "../lib/witness/precheck.ts";
import type { AttemptEntry } from "../lib/witness/store.ts";
import { appClient, loadEnv, loadRedisEnv, type App } from "./env.ts";

loadEnv();
loadRedisEnv();
const redis = redisFromEnv();
if (!redis) throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN are not set");
const store = new RedisShopStore(redis, "db:");
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest[rest.indexOf(`--${name}`) + 1];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (o: object) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

interface Made {
  app: App;
  kind: "payment" | "refund";
  captureId: string;
  resourceId: string; // the id of the event's own resource: the capture, or the refund
  type: string;
  at: number;
}
interface Run {
  run: string;
  sid: string;
  startedAt: number;
  made: Made[];
}

async function order(client: PaypalClient, invoiceId: string, value: string) {
  const c = SANDBOX_TEST_CARD;
  const o = await client.request<{ id: string; status: string; purchase_units?: { payments?: { captures?: { id: string }[] } }[] }>("create order", "POST", "/v2/checkout/orders", {
    prefer: true,
    body: { intent: "CAPTURE", purchase_units: [{ invoice_id: invoiceId, amount: { currency_code: "USD", value } }], payment_source: { card: { number: c.number, expiry: c.expiry, security_code: c.securityCode, name: c.name } } },
  });
  const capture = o.purchase_units?.[0]?.payments?.captures?.[0]?.id;
  if (o.status !== "COMPLETED" || !capture) throw new Error(`order ${o.id} did not complete at once: ${o.status}`);
  return capture;
}

async function create() {
  const n = Number(flag("n") ?? 4);
  const run: Run = { run: randomUUID().slice(0, 6), sid: `xapp${randomUUID().replaceAll("-", "").slice(0, 28)}`, startedAt: Date.now(), made: [] };
  await store.createSession(run.sid, "good", Date.now());
  for (const app of ["dev", "demo"] as const) {
    const client = appClient(app);
    for (let i = 0; i < n; i++) {
      const invoiceId = `XAPP-${app}-${run.run}-${i}`;
      const captureId = await order(client, invoiceId, (11 + i).toFixed(2));
      // Mapped before the first delivery can arrive, as the shop does it.
      await store.putOrder(run.sid, { n: run.made.length + 1, item: "gift-set", amount: (11 + i).toFixed(2), orderId: invoiceId, captureId, invoiceId, at: Date.now() });
      run.made.push({ app, kind: "payment", captureId, resourceId: captureId, type: COMPLETED, at: Date.now() });
      say({ action: "order", app, captureId });
    }
    // One refund per app, on its first capture.
    const first = run.made.find((m) => m.app === app && m.kind === "payment")!;
    const refund = await client.request<{ id: string }>("refund", "POST", `/v2/payments/captures/${first.captureId}/refund`, { body: { invoice_id: `XAPP-${app}-${run.run}-R` } });
    run.made.push({ app, kind: "refund", captureId: first.captureId, resourceId: refund.id, type: REFUNDED, at: Date.now() });
    say({ action: "refund", app, captureId: first.captureId, refund: refund.id });
  }
  const out = flag("out") ?? `cross-app-${run.run}.json`;
  writeFileSync(out, JSON.stringify(run, null, 2));
  say({ done: out, wait: "about 4 minutes, then: collect " + out });
}

interface Delivery {
  slot: string;
  tid: string;
  eid: string;
  at: number;
}

// Every stored delivery of the witness since `since`, by the resource it is about.
async function witnessDeliveries(since: number): Promise<Map<string, Delivery[]>> {
  const found = new Map<string, Delivery[]>();
  let cursor: string | number = 0;
  do {
    const [next, keys]: [string, string[]] = await redis!.scan(cursor, { match: "db:w:att:*", count: 500 });
    for (const key of keys) {
      for (const row of await redis!.lrange<string>(key, 0, -1)) {
        const e = JSON.parse(String(row)) as AttemptEntry;
        if (e.at < since || !e.raw) continue;
        const p = parseEvent(e.raw);
        if (!p.ok) continue;
        const resource = (p.parsed.event.resource as { id?: string } | undefined)?.id;
        if (!resource) continue;
        const k = `${p.parsed.eventType}|${resource}`;
        found.set(k, [...(found.get(k) ?? []), { slot: e.slot, tid: e.tid, eid: e.eid, at: e.at }]);
      }
    }
    cursor = next;
  } while (String(cursor) !== "0");
  return found;
}

// The resource ids that an app's own events list holds since `since`.
async function eventsListed(app: App, since: number): Promise<Set<string>> {
  const client = appClient(app);
  const seen = new Set<string>();
  let path: string | undefined = `/v1/notifications/webhooks-events?page_size=100&start_time=${encodeURIComponent(new Date(since - 60_000).toISOString().replace(/\.\d+Z$/, "Z"))}`;
  for (let page = 0; path && page < 10; page++) {
    const r: { events?: { event_type: string; resource?: { id?: string } }[]; links?: { rel: string; href: string }[] } = await client.request("list events", "GET", path);
    for (const e of r.events ?? []) if (e.resource?.id) seen.add(`${e.event_type}|${e.resource.id}`);
    const next = r.links?.find((l) => l.rel === "next")?.href;
    path = next ? new URL(next).pathname + new URL(next).search : undefined;
    if (next && new URL(next).host !== "api-m.sandbox.paypal.com" && new URL(next).host !== "api.sandbox.paypal.com") throw new Error("events list pointed at an unexpected host");
  }
  return seen;
}

async function collect() {
  const run = JSON.parse(readFileSync(rest[0], "utf8")) as Run;
  const deliveries = await witnessDeliveries(run.startedAt - 60_000);
  const [devList, demoList] = [await eventsListed("dev", run.startedAt), await eventsListed("demo", run.startedAt)];
  const lookup = await store.lookup(run.made.map((m) => ({ resourceId: m.resourceId, type: m.type })));
  const eids = [...new Set(run.made.flatMap((m, i) => [lookup.received[i], ...(deliveries.get(`${m.type}|${m.resourceId}`) ?? []).map((d) => d.eid)]).filter((e): e is string => !!e))];
  const reports = new Map(eids.map((e, i) => [e, i] as const));
  const records = await store.reports(eids);

  const rows = run.made.map((m, i) => {
    const key = `${m.type}|${m.resourceId}`;
    const d = deliveries.get(key) ?? [];
    const eid = lookup.received[i] ?? d[0]?.eid ?? null;
    const s = eid ? summarizeReport(records[reports.get(eid)!], Date.now()) : null;
    return {
      origin: m.app,
      kind: m.kind,
      resource: m.resourceId.slice(0, 6) + "…",
      witnessDemo: d.filter((x) => x.slot === "D").length, // webhook D of the demo app
      witnessDev: d.filter((x) => x.slot === "D-dev").length, // webhook 7N59 of the dev app
      witnessEventIds: [...new Set(d.map((x) => x.eid))].length,
      shopDemo: s ? new Set(s.map((a) => a.tid)).size : 0, // webhook S of the demo app
      listedByDev: devList.has(key),
      listedByDemo: demoList.has(key),
    };
  });
  console.table(rows);
  for (const origin of ["dev", "demo"] as const) {
    const mine = rows.filter((r) => r.origin === origin);
    const count = (f: (r: (typeof rows)[number]) => boolean) => `${mine.filter(f).length}/${mine.length}`;
    console.log(
      `made through the ${origin} app: demo D ${count((r) => r.witnessDemo > 0)} | dev 7N59 ${count((r) => r.witnessDev > 0)} | demo S ${count((r) => r.shopDemo > 0)} | in dev list ${count((r) => r.listedByDev)} | in demo list ${count((r) => r.listedByDemo)}`,
    );
  }
  writeFileSync(rest[0].replace(/\.json$/, ".result.json"), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
}

if (command === "create") await create();
else if (command === "collect" && rest[0]) await collect();
else throw new Error("usage: cross-app.ts create [--n 4] [--out file] | collect <file>");
