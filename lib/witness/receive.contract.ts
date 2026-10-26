// Acceptance tests for the receiver (plan A1, A2), run on the memory store (npm test) and on real Upstash (npm run test:redis).
// PayPal's verify endpoint is a stand-in (fakePaypal): it says SUCCESS only for deliveries registered as really signed.
// The live numbers against real PayPal come from scripts/acceptance.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ENTRY_BYTES, receiveDelivery, reverifyQuarantined, type Outcome, type WitnessDeps } from "./receive.ts";
import type { StoreFactory } from "./store.contract.ts";
import type { WitnessStore } from "./store.ts";
import { fakePaypal, fixture, forgedDelivery, OTHER_WEBHOOK_ID, requestOf, tamperSignature, TEST_WEBHOOK_ID, tidOf, type Delivery } from "./test-helpers.ts";

// Counts the calls a test makes on the store, by method.
function spy(store: WitnessStore): { store: WitnessStore; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        calls[String(prop)] = (calls[String(prop)] ?? 0) + 1;
        return v.apply(target, args);
      };
    },
  });
  return { store: proxy, calls };
}

async function setup(make: StoreFactory, opts: { budgetPerMinute?: number; budgetWindowMs?: number; known?: { delivery: Delivery; webhookId?: string }[] } = {}) {
  const { store: raw, done } = await make({ budgetPerMinute: opts.budgetPerMinute ?? 60, budgetWindowMs: opts.budgetWindowMs });
  const { store, calls } = spy(raw);
  const paypal = fakePaypal(opts.known ?? [...fixture.retry, ...fixture.singles].map((delivery) => ({ delivery })));
  const outcomes: Outcome[] = [];
  const deps: WitnessDeps = { webhookId: TEST_WEBHOOK_ID, verify: paypal.verify, store, log: (line) => void outcomes.push(line.outcome as Outcome) };
  const send = (d: Delivery, over?: Parameters<typeof requestOf>[1]) => receiveDelivery(requestOf(d, over), deps);
  return { store, calls, paypal, deps, outcomes, send, done };
}

// A delivery the stand-in treats as really signed for the witness webhook.
const real = (n: number) => forgedDelivery(n);
const known = (ds: Delivery[], webhookId?: string) => ds.map((delivery) => ({ delivery, webhookId }));

export function receiveContract(make: StoreFactory) {
  test("receiver: a real delivery is verified, stored once with its headers and body, and answered 200 without any fetch of its own", async () => {
    const t = await setup(make);
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    // Records every fetch but lets the Redis store (an Upstash REST call, when this runs on real Redis) through.
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!process.env.KV_REST_API_URL || !url.startsWith(process.env.KV_REST_API_URL)) fetched.push(url);
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const d = fixture.singles[0];
      const res = await t.send(d);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.deepEqual(fetched, [], "the receiver fetches nothing itself, least of all a URL from a header");
      const [entry] = await t.store.attempts(tidOf(d));
      assert.equal(entry.st, "ok");
      assert.equal(entry.raw, d.raw);
      assert.equal(entry.h.sig, d.headers["paypal-transmission-sig"]);
      assert.equal(entry.h.cert, d.headers["paypal-cert-url"]);
      assert.equal(entry.type, "PAYMENT.CAPTURE.COMPLETED");
      assert.ok(Buffer.byteLength(JSON.stringify(entry)) <= MAX_ENTRY_BYTES);
      assert.deepEqual(t.outcomes, ["processed"]);
    } finally {
      globalThis.fetch = realFetch;
      await t.done();
    }
  });

  test("A1-4: the same transmission id three times (a real retry log) is three attempts and one processed", async () => {
    const t = await setup(make);
    try {
      for (const d of fixture.retry) assert.equal((await t.send(d)).status, 200);
      assert.equal((await t.store.attempts(tidOf(fixture.retry[0]))).length, 3);
      assert.deepEqual(t.outcomes, ["processed", "duplicate", "duplicate"]);
    } finally {
      await t.done();
    }
  });

  test("A1-2: 15 forgeries (5 signature, 5 body, 3 missing headers, 2 other webhook) process nothing, change no state, and get one identical answer", async () => {
    const otherWebhook = [real(901), real(902)];
    const t = await setup(make, { known: [...known([...fixture.retry, ...fixture.singles]), ...known(otherWebhook, OTHER_WEBHOOK_ID)] });
    try {
      const sources = [fixture.singles[0], fixture.singles[1], fixture.singles[2], fixture.retry[0], fixture.retry[1]];
      const forgeries: Request[] = [
        ...sources.map((d, i) => requestOf(d, { headers: { "paypal-transmission-sig": tamperSignature(d.headers["paypal-transmission-sig"], 10 + i * 7) } })),
        ...sources.map((d) => requestOf(d, { raw: d.raw.replace(/"value":"(\d+)\./, '"value":"9$1.') })),
        requestOf(fixture.singles[0], { headers: { "paypal-transmission-id": null } }),
        requestOf(fixture.singles[0], { headers: { "paypal-transmission-sig": null } }),
        requestOf(fixture.singles[0], { headers: { "paypal-cert-url": null } }),
        ...otherWebhook.map((d) => requestOf(d)),
      ];
      assert.equal(forgeries.length, 15);
      const bodies = new Set<string>();
      for (const req of forgeries) {
        const res = await receiveDelivery(req, t.deps);
        assert.equal(res.status, 401);
        bodies.add(await res.text());
      }
      assert.equal(bodies.size, 1, "every refusal has the same body");
      for (const d of [...fixture.retry, ...fixture.singles, ...otherWebhook]) assert.equal((await t.store.attempts(tidOf(d))).length, 0, `no attempt stored for ${tidOf(d)}`);
      assert.equal((await t.store.listQuarantined(100)).length, 0, "nothing quarantined");
      assert.equal(t.paypal.state.calls, 12, "the 3 with missing headers never reach PayPal");
      assert.ok(t.outcomes.every((o) => o === "rejected_verify" || o === "rejected_precheck"));
    } finally {
      await t.done();
    }
  });

  test("a forged repeat of a real transmission id, before or after the real one, neither blocks nor adds to it", async () => {
    const t = await setup(make);
    try {
      const d = fixture.singles[1];
      const forged = { ...d, headers: { ...d.headers, "paypal-transmission-sig": tamperSignature(d.headers["paypal-transmission-sig"]) } };
      assert.equal((await t.send(forged)).status, 401);
      assert.equal((await t.send(d)).status, 200);
      assert.equal((await t.send(forged)).status, 401);
      assert.equal((await t.store.attempts(tidOf(d))).length, 1);
      assert.deepEqual(t.outcomes, ["rejected_verify", "processed", "rejected_verify"]);
    } finally {
      await t.done();
    }
  });

  test("the webhook id sent to PayPal is the server's, whatever the request carries", async () => {
    const t = await setup(make);
    try {
      const d = fixture.singles[0];
      await receiveDelivery(new Request("https://doorbell.test/api/witness?webhook_id=WH-ATTACKER&slot=Z", { method: "POST", headers: { ...d.headers, "paypal-webhook-id": "WH-ATTACKER", "x-webhook-id": "WH-ATTACKER" }, body: d.raw }), t.deps);
      assert.equal(t.paypal.state.params.length, 1);
      assert.equal(t.paypal.state.params[0].webhookId, TEST_WEBHOOK_ID);
    } finally {
      await t.done();
    }
  });

  test("A1-3: five failures of the verify call (2 timeouts, 2 5xx, 1 budget) are answered 200 and quarantined 5/5, then re-verified 5/5", async () => {
    const deliveries = [real(1), real(2), real(3), real(4), real(5)];
    const t = await setup(make, { budgetPerMinute: 4, budgetWindowMs: 4000, known: known(deliveries) });
    try {
      const modes = ["timeout", "timeout", "http500", "http503"] as const;
      for (const [i, mode] of modes.entries()) {
        t.paypal.state.mode = mode;
        assert.equal((await t.send(deliveries[i])).status, 200, mode);
      }
      t.paypal.state.mode = "ok";
      assert.equal((await t.send(deliveries[4])).status, 200, "budget spent");
      assert.deepEqual(t.outcomes, ["quarantined_unavailable", "quarantined_unavailable", "quarantined_unavailable", "quarantined_unavailable", "quarantined_budget"]);
      for (const d of deliveries) assert.equal((await t.store.attempts(tidOf(d))).length, 0, "nothing is processed before it is verified");
      assert.equal((await t.store.listQuarantined(100)).length, 5);

      await new Promise((r) => setTimeout(r, 4300)); // the budget window ends
      const result = await reverifyQuarantined(t.deps);
      assert.deepEqual(result, { checked: 4, verified: 4, rejected: 0, stillUnavailable: 0, unrecoverable: 0, stoppedByBudget: true });
      await new Promise((r) => setTimeout(r, 4300));
      assert.equal((await reverifyQuarantined(t.deps)).verified, 1);
      for (const d of deliveries) {
        const [entry] = await t.store.attempts(tidOf(d));
        assert.equal(entry.st, "ok");
        assert.ok(entry.rv && entry.rv >= entry.at, "re-verification time recorded");
        assert.equal(entry.why, undefined);
      }
      assert.equal((await t.store.listQuarantined(100)).length, 0);
    } finally {
      await t.done();
    }
  });

  test("re-verify: forgeries are dropped, a verify that still fails stays in the ring, an unrecoverable (oversize) entry is dropped", async () => {
    const good = real(11);
    const bad = forgedDelivery(12);
    const huge = real(13);
    huge.raw = JSON.stringify({ ...JSON.parse(huge.raw), padding: "x".repeat(12_000) });
    const t = await setup(make, { known: known([good, huge]) });
    try {
      t.paypal.state.mode = "http503";
      for (const d of [good, bad, huge]) assert.equal((await t.send(d)).status, 200);
      assert.equal((await t.store.listQuarantined(100)).length, 3);
      const still = await reverifyQuarantined(t.deps);
      assert.equal(still.stillUnavailable, 2, "the oversize entry cannot be checked, so it is not counted as unavailable");
      assert.equal(still.unrecoverable, 1);
      t.paypal.state.mode = "ok";
      const result = await reverifyQuarantined(t.deps);
      assert.equal(result.verified, 1);
      assert.equal(result.rejected, 1);
      assert.equal((await t.store.listQuarantined(100)).length, 0);
      assert.equal((await t.store.attempts(tidOf(good))).length, 1);
      assert.equal((await t.store.attempts(tidOf(bad))).length, 0);
    } finally {
      await t.done();
    }
  });

  test("A1-6: 200 well-formed forgeries in a minute make at most 60 verify calls, and the shared budget stops being asked once it is spent", async () => {
    const t = await setup(make, { budgetPerMinute: 60 });
    try {
      const forgeries = Array.from({ length: 200 }, (_, i) => forgedDelivery(1000 + i));
      const statuses: number[] = [];
      for (let from = 0; from < forgeries.length; from += 20) {
        // 20 at a time, as a burst of requests arrives
        statuses.push(...(await Promise.all(forgeries.slice(from, from + 20).map(async (d) => (await t.send(d)).status))));
      }
      assert.equal(t.paypal.state.calls, 60);
      assert.equal(statuses.filter((s) => s === 401).length, 60, "the 60 that reached PayPal were refused");
      assert.equal(statuses.filter((s) => s === 200).length, 140, "the rest were quarantined, not dropped");
      assert.equal((await t.store.listQuarantined(1000)).length, 140);
      assert.ok(t.calls.reserveVerify <= 60 + 20, `the budget counter was asked ${t.calls.reserveVerify} times for 200 requests`);
    } finally {
      await t.done();
    }
  });

  test("A2: an entry over 8 KB keeps the hash and a flag instead of the body", async () => {
    const d = real(21);
    d.raw = JSON.stringify({ ...JSON.parse(d.raw), padding: "y".repeat(9_000) });
    const t = await setup(make, { known: known([d]) });
    try {
      assert.equal((await t.send(d)).status, 200);
      const [entry] = await t.store.attempts(tidOf(d));
      assert.equal(entry.big, true);
      assert.equal(entry.raw, undefined);
      assert.equal(entry.len, Buffer.byteLength(d.raw));
      assert.match(entry.sha, /^[0-9a-f]{64}$/);
      assert.ok(Buffer.byteLength(JSON.stringify(entry)) <= MAX_ENTRY_BYTES);
    } finally {
      await t.done();
    }
  });

  test("a body over 64 KB, a body that is not an event, and a verify answer of 400 are refused without storing anything", async () => {
    const t = await setup(make);
    try {
      const d = fixture.singles[0];
      assert.equal((await t.send(d, { raw: "x".repeat(70_000) })).status, 401);
      assert.equal((await t.send(d, { raw: "[1,2,3]" })).status, 401);
      assert.equal(t.paypal.state.calls, 0);
      t.paypal.state.mode = "http400";
      assert.equal((await t.send(d)).status, 401);
      t.paypal.state.mode = "weird";
      assert.equal((await t.send(d)).status, 200, "an answer that is neither SUCCESS nor FAILURE is not a verdict");
      assert.equal((await t.store.listQuarantined(10)).length, 1);
      assert.equal((await t.store.attempts(tidOf(d))).length, 0);
    } finally {
      await t.done();
    }
  });
}

// Two apps' witness webhooks deliver to one URL (S2): the receiver tries each configured webhook id, and a delivery is stored under
// the slot of the one that verified it.
export function multiTargetContract(make: StoreFactory) {
  const DEV_ID = "WH-FIXTURE-DEV-APP-0001";
  const extra = [{ slot: "D-dev", webhookId: DEV_ID }];

  async function setupTwo(opts: { budgetPerMinute?: number; known: { delivery: Delivery; webhookId?: string }[]; onVerified?: WitnessDeps["onVerified"] }) {
    const t = await setup(make, { budgetPerMinute: opts.budgetPerMinute, known: opts.known });
    const deps: WitnessDeps = { ...t.deps, extraTargets: extra, onVerified: opts.onVerified };
    return { ...t, deps, send: (d: Delivery) => receiveDelivery(requestOf(d), deps) };
  }

  test("two webhooks, one URL: each delivery is stored under the slot of the webhook that verified it, and costs one verify call per webhook tried", async () => {
    const mine = real(31);
    const devs = real(32);
    const t = await setupTwo({ known: [...known([mine]), ...known([devs], DEV_ID)] });
    try {
      assert.equal((await t.send(mine)).status, 200);
      assert.equal(t.paypal.state.calls, 1, "the first webhook verified it: one call");
      assert.equal((await t.send(devs)).status, 200);
      assert.equal(t.paypal.state.calls, 3, "the second delivery failed against D, then verified against D-dev: two calls");
      assert.deepEqual(t.paypal.state.params.map((p) => p.webhookId), [TEST_WEBHOOK_ID, TEST_WEBHOOK_ID, DEV_ID]);
      assert.equal((await t.store.attempts(tidOf(mine)))[0].slot, "D");
      assert.equal((await t.store.attempts(tidOf(devs)))[0].slot, "D-dev");
      assert.deepEqual(t.outcomes, ["processed", "processed"]);
    } finally {
      await t.done();
    }
  });

  test("a forgery fails against every webhook: refused with the usual answer, nothing stored, one call per webhook", async () => {
    const forged = forgedDelivery(33);
    const t = await setupTwo({ known: [] });
    try {
      const res = await t.send(forged);
      assert.equal(res.status, 401);
      assert.equal(t.paypal.state.calls, 2);
      assert.equal((await t.store.attempts(tidOf(forged))).length, 0);
      assert.deepEqual(t.outcomes, ["rejected_verify"]);
    } finally {
      await t.done();
    }
  });

  test("when the budget runs out between two webhooks the delivery is quarantined, not refused", async () => {
    const devs = real(34);
    const t = await setupTwo({ budgetPerMinute: 1, known: known([devs], DEV_ID) });
    try {
      assert.equal((await t.send(devs)).status, 200);
      assert.deepEqual(t.outcomes, ["quarantined_budget"]);
      assert.equal(t.paypal.state.calls, 1);
      assert.equal((await t.store.listQuarantined(10)).length, 1);
      assert.equal((await t.store.attempts(tidOf(devs))).length, 0);
    } finally {
      await t.done();
    }
  });

  test("onVerified runs once, for the first verified attempt of a transmission id only", async () => {
    const d = real(35);
    const seen: string[] = [];
    const t = await setupTwo({ known: known([d]), onVerified: async (entry) => void seen.push(`${entry.tid}:${entry.slot}`) });
    try {
      assert.equal((await t.send(d)).status, 200);
      assert.equal((await t.send(d)).status, 200, "a retry with the same transmission id");
      assert.deepEqual(seen, [`${tidOf(d)}:D`]);
    } finally {
      await t.done();
    }
  });

  test("a delivery that is verified late (re-verify) reaches the hook once with the slot that verified it; a hook that throws there is logged and does not stop the re-verify", async () => {
    const [a, b] = [real(37), real(38)];
    const seen: string[] = [];
    const t = await setupTwo({
      known: known([a, b]),
      onVerified: async (entry) => {
        seen.push(`${entry.tid}:${entry.slot}:${entry.st}`);
        if (entry.tid === tidOf(a)) throw new Error("hook down");
      },
    });
    const logged: Record<string, unknown>[] = [];
    try {
      t.paypal.state.mode = "http503";
      assert.equal((await t.send(a)).status, 200);
      assert.equal((await t.send(b)).status, 200);
      assert.deepEqual(seen, [], "nothing was verified, so the hook has not run");
      t.paypal.state.mode = "ok";
      const result = await reverifyQuarantined({ ...t.deps, log: (line) => void logged.push(line) });
      assert.equal(result.verified, 2);
      assert.deepEqual(seen, [`${tidOf(a)}:D:ok`, `${tidOf(b)}:D:ok`]);
      assert.deepEqual(logged.map((l) => l.outcome), ["reverify_hook_failed"]);
      assert.equal((await t.store.attempts(tidOf(a))).length, 1);
    } finally {
      await t.done();
    }
  });

  test("a hook that throws changes neither the answer nor the stored record", async () => {
    const d = real(36);
    const t = await setupTwo({
      known: known([d]),
      onVerified: async () => {
        throw new Error("hook down");
      },
    });
    try {
      assert.equal((await t.send(d)).status, 200);
      assert.equal((await t.store.attempts(tidOf(d))).length, 1);
      assert.deepEqual(t.outcomes, ["processed"]);
    } finally {
      await t.done();
    }
  });
}
