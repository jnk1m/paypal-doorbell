// Plan assumption 7: can PayPal resend an event the witness has just heard, before that event shows up in the events list (80-163 s, F3)?
// For each trial: make a capture, wait until the witness stores its COMPLETED delivery, ask PayPal for the event and the list, resend it
// to the witness webhook at once, and time the new delivery (it must carry a new transmission id, F16).
//   npx tsx scripts/resend-test.ts [trials]
import { PaypalClient, PaypalError, SANDBOX_TEST_CARD } from "../lib/pay/paypal.ts";
import { redisFromEnv } from "../lib/redis.ts";
import type { AttemptEntry } from "../lib/witness/store.ts";
import { loadEnv, loadRedisEnv } from "./env.ts";

loadEnv();
loadRedisEnv();
const redis = redisFromEnv();
const webhookId = process.env.PAYPAL_WITNESS_WEBHOOK_ID;
if (!redis || !webhookId) throw new Error("needs Upstash settings and PAYPAL_WITNESS_WEBHOOK_ID");
const client = PaypalClient.fromEnv();
const trials = Number(process.argv[2] ?? 3);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every stored attempt whose body mentions this capture id: [{tid, eid, at}]
async function deliveriesFor(captureId: string): Promise<{ tid: string; eid: string; at: number; type: string }[]> {
  const out: { tid: string; eid: string; at: number; type: string }[] = [];
  let cursor: string | number = 0;
  do {
    const [next, keys]: [string, string[]] = await redis!.scan(cursor, { match: "db:w:att:*", count: 500 });
    for (const key of keys) {
      const [row] = await redis!.lrange<string>(key, 0, 0);
      const e = JSON.parse(String(row)) as AttemptEntry;
      if (e.raw?.includes(`"${captureId}"`) && e.type === "PAYMENT.CAPTURE.COMPLETED") out.push({ tid: e.tid, eid: e.eid, at: e.at, type: e.type });
    }
    cursor = next;
  } while (String(cursor) !== "0");
  return out;
}

async function waitFor<T>(what: string, limitMs: number, f: () => Promise<T | undefined>): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    const v = await f();
    if (v !== undefined) return v;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}


const pending: { trial: number; eid: string; captureId: string; tid: string; t0: number }[] = [];

// Asks PayPal to resend the event to the witness webhook and times the new delivery (a new transmission id, same event id).
async function resend(eid: string, captureId: string, firstTid: string): Promise<{ resend: string; result: string }> {
  const at = Date.now();
  let status: string;
  try {
    await client.request("resend event", "POST", `/v1/notifications/webhooks-events/${eid}/resend`, { body: { webhook_ids: [webhookId] } });
    status = "accepted (2xx)";
  } catch (e) {
    status = e instanceof PaypalError ? `${e.status} ${e.codes.join(" ")}` : "error";
  }
  let result = "no new delivery";
  if (status.startsWith("accepted")) {
    const second = await waitFor("the resent delivery", 60_000, async () => (await deliveriesFor(captureId)).find((d) => d.tid !== firstTid)).catch(() => undefined);
    if (second) result = `new delivery ${((second.at - at) / 1000).toFixed(1)} s after the resend; same event id: ${second.eid === eid}`;
  }
  return { resend: status, result };
}

for (let i = 1; i <= trials; i++) {
  const c = SANDBOX_TEST_CARD;
  const t0 = Date.now();
  const order = await client.request<{ purchase_units: { payments: { captures: { id: string }[] } }[] }>("create order", "POST", "/v2/checkout/orders", {
    prefer: true,
    body: {
      intent: "CAPTURE",
      purchase_units: [{ invoice_id: `DBELL-RESEND-${t0}`, amount: { currency_code: "USD", value: "7.00" } }],
      payment_source: { card: { number: c.number, expiry: c.expiry, security_code: c.securityCode, name: c.name } },
    },
  });
  const captureId = order.purchase_units[0].payments.captures[0].id;
  const heard = await waitFor("the witness to hear the capture", 90_000, async () => (await deliveriesFor(captureId))[0]);
  const heardAfter = (heard.at - t0) / 1000;

  // What PayPal says about this event right now.
  let getStatus: number | string;
  try {
    await client.request("get event", "GET", `/v1/notifications/webhooks-events/${heard.eid}`);
    getStatus = 200;
  } catch (e) {
    getStatus = e instanceof PaypalError ? e.status : "error";
  }
  const start = new Date(t0 - 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  const list = await client.request<{ events?: { id: string }[] }>("list events", "GET", `/v1/notifications/webhooks-events?page_size=100&start_time=${start}`);
  const inList = (list.events ?? []).some((e) => e.id === heard.eid);

  const early = await resend(heard.eid, captureId, heard.tid);
  console.log(JSON.stringify({ trial: i, phase: "right after the witness heard it", heardAfterS: heardAfter, secondsSinceEvent: ((Date.now() - t0) / 1000).toFixed(0), getEvent: getStatus, eventInList: inList, ...early }));
  pending.push({ trial: i, eid: heard.eid, captureId, tid: heard.tid, t0 });
  await sleep(2000);
}

// Phase 2: the same events once PayPal lists them.
for (const p of pending) {
  const start = new Date(p.t0 - 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  const listedAfter = await waitFor("the event to be listed", 360_000, async () => {
    const list = await client.request<{ events?: { id: string }[] }>("list events", "GET", `/v1/notifications/webhooks-events?page_size=100&start_time=${start}`);
    return (list.events ?? []).some((e) => e.id === p.eid) ? (Date.now() - p.t0) / 1000 : undefined;
  }).catch(() => undefined);
  const late = await resend(p.eid, p.captureId, p.tid);
  console.log(JSON.stringify({ trial: p.trial, phase: "after PayPal lists the event", listedAfterS: listedAfter && Math.round(listedAfter), ...late }));
}
