// The shop webhook with each handler file (A11, in process). The signature check is a stand-in for PayPal's verify endpoint
// (see test-helpers.ts); the live runs against real PayPal are scripts/s2-acceptance.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleShopDelivery } from "./webhook.ts";
import { requireModeAvailable } from "./api.ts";
import { settingWebhookIdFromEnv } from "./config.ts";
import { summarizeReport } from "./reporter.ts";
import { completedEvent, OTHER_WEBHOOK_ID, refundedEvent, requestOf, SHOP_WEBHOOK_ID, shopWorld } from "./test-helpers.ts";
import { MODES } from "./types.ts";
import { HttpError } from "../web/http.ts";

const books = async (w: ReturnType<typeof shopWorld>, sid: string, captureId: string) => (await w.store.getBook(sid, captureId))?.state;

async function paidThenRefunded(w: ReturnType<typeof shopWorld>, mode: Parameters<typeof w.session>[0], switchTo?: Parameters<typeof w.session>[0]) {
  const { sid, captureId, refundId } = await w.session(mode);
  const completed = w.paypal.sign(completedEvent(captureId));
  const refunded = w.paypal.sign(refundedEvent(captureId, refundId));
  const first = await handleShopDelivery(requestOf(completed), w.deps);
  if (switchTo) assert.ok(await w.store.setMode(sid, switchTo));
  const second = await handleShopDelivery(requestOf(refunded), w.deps);
  return { sid, captureId, refundId, completed, refunded, statuses: [first.status, second.status] };
}

test("good: a payment and then its refund are booked in order, and the reporter shows both deliveries answered 200", async () => {
  const w = shopWorld();
  const t = await paidThenRefunded(w, "good");
  assert.deepEqual(t.statuses, [200, 200]);
  assert.equal(await books(w, t.sid, t.captureId), "refunded");
  const [rec] = await w.store.reports([t.completed.eid]);
  assert.deepEqual(summarizeReport(rec, Date.now())?.map((a) => [a.tid, a.state, a.status]), [[t.completed.tid, "responded", 200]]);
});

test("good: a late 'paid' does not undo a 'refunded' (events arriving out of order)", async () => {
  const w = shopWorld();
  const { sid, captureId, refundId } = await w.session("good");
  await handleShopDelivery(requestOf(w.paypal.sign(refundedEvent(captureId, refundId))), w.deps);
  await handleShopDelivery(requestOf(w.paypal.sign(completedEvent(captureId))), w.deps);
  assert.equal(await books(w, sid, captureId), "refunded");
});

test("last_write_wins: the same out-of-order arrival leaves the books saying paid", async () => {
  const w = shopWorld();
  const { sid, captureId, refundId } = await w.session("last_write_wins");
  assert.equal((await handleShopDelivery(requestOf(w.paypal.sign(refundedEvent(captureId, refundId))), w.deps)).status, 200);
  assert.equal((await handleShopDelivery(requestOf(w.paypal.sign(completedEvent(captureId))), w.deps)).status, 200);
  assert.equal(await books(w, sid, captureId), "paid");
});

test("last_write_wins: in order it behaves like good (the bug only shows when the order is reversed)", async () => {
  const w = shopWorld();
  const t = await paidThenRefunded(w, "last_write_wins");
  assert.deepEqual(t.statuses, [200, 200]);
  assert.equal(await books(w, t.sid, t.captureId), "refunded");
});

test("ack_then_drop: the refund is answered 200 and reported as such, and the books do not change", async () => {
  const w = shopWorld();
  const t = await paidThenRefunded(w, "good", "ack_then_drop");
  assert.deepEqual(t.statuses, [200, 200]);
  assert.equal(await books(w, t.sid, t.captureId), "paid", "the payment was booked before the bug, the refund was acknowledged and dropped");
  const [rec] = await w.store.reports([t.refunded.eid]);
  assert.deepEqual(summarizeReport(rec, Date.now())?.map((a) => [a.state, a.status]), [["responded", 200]]);
});

test("bad_body: a genuine delivery is answered 401 although the signature is good, and the same delivery is accepted by good", async () => {
  const w = shopWorld();
  const t = await paidThenRefunded(w, "good", "bad_body");
  assert.deepEqual(t.statuses, [200, 401]);
  assert.equal(await books(w, t.sid, t.captureId), "paid");
  const [rec] = await w.store.reports([t.refunded.eid]);
  assert.deepEqual(summarizeReport(rec, Date.now())?.map((a) => [a.tid, a.state, a.status]), [[t.refunded.tid, "responded", 401]]);

  await w.store.setMode(t.sid, "good"); // the fix is deployed; PayPal's retry carries the same transmission id
  assert.equal((await handleShopDelivery(requestOf(t.refunded), w.deps)).status, 200);
  assert.equal(await books(w, t.sid, t.captureId), "refunded");
  const [after] = await w.store.reports([t.refunded.eid]);
  assert.deepEqual(summarizeReport(after, Date.now())?.map((a) => a.status), [401, 200], "the retry is a second attempt of the same event, in order");
});

test("the mode is read on every delivery: switching it changes the very next one", async () => {
  const w = shopWorld();
  const { sid, captureId, refundId } = await w.session("ack_then_drop");
  const d = w.paypal.sign(completedEvent(captureId));
  await handleShopDelivery(requestOf(d), w.deps);
  assert.equal(await books(w, sid, captureId), undefined);
  await w.store.setMode(sid, "good");
  await handleShopDelivery(requestOf(d), w.deps);
  assert.equal(await books(w, sid, captureId), "paid");
  await w.store.setMode(sid, "bad_body");
  assert.equal((await handleShopDelivery(requestOf(w.paypal.sign(refundedEvent(captureId, refundId))), w.deps)).status, 401);
});

test("two sessions in different modes, deliveries interleaved: each gets its own behaviour and its own books", async () => {
  const w = shopWorld();
  const a = await w.session("good");
  const b = await w.session("ack_then_drop");
  const deliveries = [
    w.paypal.sign(completedEvent(a.captureId)),
    w.paypal.sign(completedEvent(b.captureId)),
    w.paypal.sign(refundedEvent(a.captureId, a.refundId)),
    w.paypal.sign(refundedEvent(b.captureId, b.refundId)),
  ];
  const statuses = await Promise.all(deliveries.map(async (d) => (await handleShopDelivery(requestOf(d), w.deps)).status));
  assert.deepEqual(statuses, [200, 200, 200, 200]);
  assert.equal(await books(w, a.sid, a.captureId), "refunded");
  assert.equal(await books(w, b.sid, b.captureId), undefined, "the dropped session booked nothing");
  assert.equal(await books(w, b.sid, a.captureId), undefined, "and session a's order never appears in b's books");
});

test("an event about an order that is not in any session is answered 200 and leaves no trace; a forged request is refused 401", async () => {
  const w = shopWorld();
  const stranger = w.paypal.sign(completedEvent("CAPTUREOFSOMEONEELSE"));
  assert.equal((await handleShopDelivery(requestOf(stranger), w.deps)).status, 200);
  assert.equal(w.paypal.state.calls, 0, "nothing was verified or run for it");
  assert.deepEqual(await w.store.reports([stranger.eid]), [null], "no report: the shop never saw it as its own");
  assert.equal(w.logs.at(-1)?.outcome, "foreign");

  const { captureId } = await w.session("good");
  const d = w.paypal.sign(completedEvent(captureId));
  const refusals: Parameters<typeof requestOf>[1][] = [{ headers: { "paypal-transmission-sig": null } }, { headers: { "paypal-cert-url": "https://evil.example/v1/notifications/certs/CERT-1" } }, { raw: "[1]" }];
  for (const over of refusals) {
    assert.equal((await handleShopDelivery(requestOf(d, over), w.deps)).status, 401);
  }
  assert.deepEqual(await w.store.reports([d.eid]), [null], "a refused request is not reported either");
});

test("a signature PayPal does not confirm is answered 401 by the handler, and recorded as such", async () => {
  const w = shopWorld();
  const { captureId } = await w.session("good");
  const forged = { ...w.paypal.sign(completedEvent(captureId)), raw: JSON.stringify(completedEvent(captureId, "99.00")) };
  assert.equal((await handleShopDelivery(requestOf(forged), w.deps)).status, 401);
  const [rec] = await w.store.reports([JSON.parse(forged.raw).id]);
  assert.deepEqual(summarizeReport(rec, Date.now())?.map((a) => a.status), [401]);
});

test("a handler that throws is reported as 500 and the error reaches the caller; a reporter that cannot write does not stop the shop", async () => {
  const w = shopWorld();
  const { sid, captureId } = await w.session("good");
  const d = w.paypal.sign(completedEvent(captureId));
  w.paypal.state.mode = "http503";
  await assert.rejects(handleShopDelivery(requestOf(d), w.deps), /verify webhook signature failed: HTTP 503/);
  const [rec] = await w.store.reports([d.eid]);
  assert.deepEqual(summarizeReport(rec, Date.now())?.map((a) => [a.state, a.status]), [["responded", 500]]);

  w.paypal.state.mode = "ok";
  const broken = { ...w.deps, reporter: { received: async () => { throw new Error("redis down"); }, responded: async () => { throw new Error("redis down"); } } };
  assert.equal((await handleShopDelivery(requestOf(d), broken)).status, 200);
  assert.equal(await books(w, sid, captureId), "paid");
  assert.ok(w.logs.some((l) => l.outcome === "reporter_failed"));
});

// ---- the setting bug: the handler is the working one, the webhook id it is checked against is not the shop's ------------------------------

function watching(w: ReturnType<typeof shopWorld>) {
  const asked: string[] = [];
  const deps = { ...w.deps, verify: async (p: Parameters<typeof w.deps.verify>[0]) => (asked.push(p.webhookId), w.deps.verify(p)) };
  return { asked, deps };
}

test("wrong_webhook_id_setting: the signature is checked against another webhook's id, so a genuine delivery is answered 401 on each try and nothing is booked", async () => {
  const w = shopWorld();
  const { asked, deps } = watching(w);
  const { sid, captureId, refundId } = await w.session("wrong_webhook_id_setting");
  const refunded = w.paypal.sign(refundedEvent(captureId, refundId));
  for (let i = 0; i < 3; i++) assert.equal((await handleShopDelivery(requestOf(refunded), deps)).status, 401, `try ${i + 1}`);
  assert.deepEqual(asked, [OTHER_WEBHOOK_ID, OTHER_WEBHOOK_ID, OTHER_WEBHOOK_ID], "asked PayPal about the other webhook, never the shop's own");
  assert.equal(await books(w, sid, captureId), undefined);
  const [rec] = await w.store.reports([refunded.eid]);
  assert.deepEqual(summarizeReport(rec, Date.now())?.map((a) => [a.state, a.status]), [["responded", 401], ["responded", 401], ["responded", 401]], "the reporter shows three answered 401");

  // The fix is the setting, not the code: with the shop's own id (mode good) the very same delivery verifies and is booked.
  await w.store.setMode(sid, "good");
  assert.equal((await handleShopDelivery(requestOf(refunded), deps)).status, 200);
  assert.equal(asked.at(-1), SHOP_WEBHOOK_ID);
  assert.equal(await books(w, sid, captureId), "refunded");
});

test("every other mode checks the signature against the shop's own webhook id, and only that", async () => {
  for (const mode of MODES) {
    const w = shopWorld();
    const { asked, deps } = watching(w);
    const { captureId } = await w.session(mode);
    await handleShopDelivery(requestOf(w.paypal.sign(completedEvent(captureId))), deps);
    assert.ok(asked.length >= 1, `${mode}: it verified`);
    assert.ok(asked.every((id) => id === SHOP_WEBHOOK_ID), `${mode}: ${asked.join(",")}`);
  }
});

test("the setting-bug mode cannot run without the other webhook id: the delivery is reported as 500 and the error reaches the caller; PayPal is not asked; the mode route refuses it", async () => {
  const w = shopWorld();
  const { asked, deps } = watching(w);
  const { captureId } = await w.session("wrong_webhook_id_setting");
  const d = w.paypal.sign(completedEvent(captureId));
  await assert.rejects(handleShopDelivery(requestOf(d), { ...deps, settingWebhookId: undefined }), /none is configured \(PAYPAL_WITNESS_WEBHOOK_ID\)/);
  assert.deepEqual(asked, [], "no verify call was made with the shop's own id instead");
  const [rec] = await w.store.reports([d.eid]);
  assert.deepEqual(summarizeReport(rec, Date.now())?.map((a) => [a.state, a.status]), [["responded", 500]]);

  const refusal = (mode: Parameters<typeof requireModeAvailable>[0], id: string | undefined) => {
    try {
      requireModeAvailable(mode, id);
      return "allowed";
    } catch (e) {
      return e instanceof HttpError ? e.status : "other error";
    }
  };
  assert.equal(refusal("wrong_webhook_id_setting", undefined), 409);
  assert.equal(refusal("wrong_webhook_id_setting", "95S68045X9784900W"), "allowed");
  for (const mode of MODES) assert.equal(refusal(mode, undefined), "allowed", `${mode} needs no other id`);
});

test("the other webhook id comes from PAYPAL_WITNESS_WEBHOOK_ID and only when it has the shape of one", () => {
  assert.equal(settingWebhookIdFromEnv({ PAYPAL_WITNESS_WEBHOOK_ID: "95S68045X9784900W" }), "95S68045X9784900W");
  for (const bad of [undefined, "", "short", "has spaces in it 123", "x".repeat(31)]) assert.equal(settingWebhookIdFromEnv({ PAYPAL_WITNESS_WEBHOOK_ID: bad }), undefined, String(bad));
  assert.equal(settingWebhookIdFromEnv({}), undefined);
  assert.equal(settingWebhookIdFromEnv({ PAYPAL_WITNESS_WEBHOOK_ID: "8D519417XY9586355", PAYPAL_SHOP_WEBHOOK_ID: "8D519417XY9586355" }), undefined, "the shop's own id is not a wrong id");
});
