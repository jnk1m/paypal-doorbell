// The stamp screen's data. "planted by us" is on every bug and on nothing else (DO NOT CHANGE 8); the chips tell the three
// places apart (D heard / S received / what S answered).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODES, isPlanted } from "./types.ts";
import { MODE_FILE, PLANTED_LABEL } from "./modes.ts";
import { COMPLETED, REFUNDED } from "./events.ts";
import { buildView, SETTLE_MS } from "./view.ts";
import { handleShopDelivery } from "./webhook.ts";
import { completedEvent, refundedEvent, requestOf, shopWorld } from "./test-helpers.ts";

test("A11: 'planted by us' is shown for each of the three bugs and not for the working handler (0 missing)", async () => {
  const w = shopWorld();
  for (const mode of MODES) {
    const { sid } = await w.session(mode);
    const view = await buildView(w.store, sid, (await w.store.getSession(sid))!, Date.now());
    assert.equal(view.session.planted, isPlanted(mode), mode);
    assert.equal(view.session.file, MODE_FILE[mode]);
    assert.equal(view.session.plantedLabel, PLANTED_LABEL);
  }
  assert.equal(PLANTED_LABEL, "planted by us");
  const lane = readFileSync(new URL("../../app/_components/live-lane.tsx", import.meta.url), "utf8");
  assert.match(lane, /\bPLANTED\b/, "the live lane renders the label next to each planted mode");
  assert.match(readFileSync(new URL("../ui/copy.ts", import.meta.url), "utf8"), /PLANTED = PLANTED_LABEL/, "and it is the one label of lib/shop/mode-files.ts");
});

test("per-event chips: D heard / S received / what S answered, for an order and its refund", async () => {
  const w = shopWorld();
  const { sid, captureId, refundId } = await w.session("good");
  await w.store.putOrder(sid, { ...(await w.store.orders(sid))[0], refund: { id: refundId, invoiceId: "MM-fixture-1-R", at: Date.now() } });
  const completed = w.paypal.sign(completedEvent(captureId));
  const refunded = w.paypal.sign(refundedEvent(captureId, refundId));

  // D hears both; the shop receives only the first
  await w.store.noteHeard({ resourceId: captureId, type: COMPLETED }, { eid: completed.eid, tid: "dtid-1", at: 1, slot: "D" });
  await w.store.noteHeard({ resourceId: refundId, type: REFUNDED }, { eid: refunded.eid, tid: "dtid-2", at: 2, slot: "D" });
  await handleShopDelivery(requestOf(completed), w.deps);

  const view = await buildView(w.store, sid, (await w.store.getSession(sid))!, Date.now());
  const [order] = view.orders;
  const [c, r] = order.events;
  assert.equal(c.kind, "completed");
  assert.deepEqual([c.heard?.slot, c.received?.map((a) => [a.state, a.status])], ["D", [["responded", 200]]]);
  assert.equal(r.kind, "refunded");
  assert.equal(r.heard?.slot, "D");
  assert.deepEqual([c.heard?.tid, r.heard?.tid], ["dtid-1", "dtid-2"], "the transmission id D stored the delivery under, which is how a replay finds the signed event");
  assert.equal(r.received, null, "heard by the witness, never reported by the shop");
  assert.equal(r.eid, refunded.eid, "the event id comes from the witness when the shop never saw it");
  assert.equal(order.paypal, "REFUNDED");
  assert.equal(order.book?.state, "paid");
});

test("books: agree, waiting while PayPal's delivery may still be on its way, differ after that", async () => {
  const w = shopWorld();
  const { sid, captureId, refundId } = await w.session("ack_then_drop");
  const session = (await w.store.getSession(sid))!;
  const created = (await w.store.orders(sid))[0].at;
  const at = (offset: number) => buildView(w.store, sid, session, created + offset).then((v) => v.orders[0].books);
  assert.equal(await at(1_000), "waiting");
  assert.equal(await at(SETTLE_MS + 1_000), "differ");
  await w.store.setBook(sid, captureId, { state: "paid", amount: "48.00", eid: "WH-1", at: created });
  assert.equal(await at(SETTLE_MS + 1_000), "agree");
  await w.store.putOrder(sid, { ...(await w.store.orders(sid))[0], refund: { id: refundId, invoiceId: "MM-fixture-1-R", at: created + 60_000 } });
  assert.equal(await at(61_000), "waiting", "the refund is new, the books say paid");
  assert.equal(await at(60_000 + SETTLE_MS + 1_000), "differ");
});
