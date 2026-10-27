// Tests every ShopStore implementation passes: MemoryShopStore (npm test) and RedisShopStore on real Upstash (npm run test:redis).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ShopStore } from "./store.ts";
import type { OrderRecord } from "./types.ts";

export type ShopStoreFactory = () => Promise<{ store: ShopStore; done: () => Promise<void> }>;

const order = (n: number, captureId: string): OrderRecord => ({ n, item: "gift-set", amount: "48.00", orderId: `ORDER-${captureId}`, captureId, invoiceId: `MM-test-${n}`, at: 1_000 + n });

export function shopStoreContract(make: ShopStoreFactory) {
  test("shop store: a session keeps its mode, the mode can be changed, and a session that does not exist is not created by changing its mode", async () => {
    const { store, done } = await make();
    try {
      await store.createSession("sess-a", "good", 111);
      assert.deepEqual(await store.getSession("sess-a"), { mode: "good", at: 111 });
      assert.equal(await store.setMode("sess-a", "bad_body"), true);
      assert.equal((await store.getSession("sess-a"))?.mode, "bad_body");
      assert.equal(await store.setMode("sess-missing", "bad_body"), false);
      assert.equal(await store.getSession("sess-missing"), null);
    } finally {
      await done();
    }
  });

  test("shop store: an order maps its capture to its session, orders come back in order, and updating one replaces it", async () => {
    const { store, done } = await make();
    try {
      await store.putOrder("sess-a", order(2, "CAPTURE-TWO-0001"));
      await store.putOrder("sess-a", order(1, "CAPTURE-ONE-0001"));
      await store.putOrder("sess-b", order(1, "CAPTURE-OTHER-001"));
      assert.equal(await store.sessionOfCapture("CAPTURE-ONE-0001"), "sess-a");
      assert.equal(await store.sessionOfCapture("CAPTURE-OTHER-001"), "sess-b");
      assert.equal(await store.sessionOfCapture("CAPTURE-NOBODY-01"), null);
      assert.deepEqual((await store.orders("sess-a")).map((o) => o.n), [1, 2]);
      assert.deepEqual((await store.orders("sess-b")).map((o) => o.n), [1]);
      await store.putOrder("sess-a", { ...order(1, "CAPTURE-ONE-0001"), refund: { id: "REFUND-ONE-00001", invoiceId: "MM-test-1-R", at: 5_000 } });
      const [first, second] = await store.orders("sess-a");
      assert.equal(first.refund?.id, "REFUND-ONE-00001");
      assert.equal(second.refund, undefined);
      assert.equal((await store.orders("sess-a")).length, 2);
    } finally {
      await done();
    }
  });

  test("shop store: books are per session and per capture", async () => {
    const { store, done } = await make();
    try {
      assert.equal(await store.getBook("sess-a", "CAPTURE-ONE-0001"), null);
      await store.setBook("sess-a", "CAPTURE-ONE-0001", { state: "paid", amount: "48.00", eid: "WH-1", at: 1 });
      await store.setBook("sess-a", "CAPTURE-ONE-0001", { state: "refunded", amount: "48.00", eid: "WH-2", at: 2 });
      await store.setBook("sess-b", "CAPTURE-ONE-0001", { state: "paid", amount: "48.00", eid: "WH-3", at: 3 });
      assert.equal((await store.getBook("sess-a", "CAPTURE-ONE-0001"))?.state, "refunded");
      assert.equal((await store.getBook("sess-b", "CAPTURE-ONE-0001"))?.state, "paid");
      assert.deepEqual(Object.keys(await store.books("sess-a")), ["CAPTURE-ONE-0001"]);
      assert.deepEqual(await store.books("sess-empty"), {});
    } finally {
      await done();
    }
  });

  test("shop store: what the witness heard and what the shop received are looked up by resource and type, by position", async () => {
    const { store, done } = await make();
    try {
      const a = { resourceId: "CAPTURE-ONE-0001", type: "PAYMENT.CAPTURE.COMPLETED" };
      const b = { resourceId: "REFUND-ONE-00001", type: "PAYMENT.CAPTURE.REFUNDED" };
      await store.noteHeard(a, { eid: "WH-1", tid: "tid-1", at: 10, slot: "D" });
      await store.noteReceived(a, "WH-1");
      await store.noteReceived(b, "WH-2");
      const found = await store.lookup([b, a, { resourceId: "NOTHING-000001", type: "PAYMENT.CAPTURE.COMPLETED" }]);
      assert.deepEqual(found.heard, [null, { eid: "WH-1", tid: "tid-1", at: 10, slot: "D" }, null]);
      assert.deepEqual(found.received, ["WH-2", "WH-1", null]);
      assert.deepEqual(await store.lookup([]), { heard: [], received: [] });
    } finally {
      await done();
    }
  });

  test("shop store: resends are counted per session up to the cap, one resend of an event at a time, and a released resend gives its count back", async () => {
    const { store, done } = await make();
    try {
      assert.deepEqual(await store.heals("sess-a"), { resends: 0, records: {} });
      assert.equal(await store.reserveResend("sess-a", "WH-ONE", 3), "reserved");
      assert.equal(await store.reserveResend("sess-a", "WH-ONE", 3), "busy", "the same event is being sent");
      assert.equal(await store.reserveResend("sess-a", "WH-TWO", 3), "reserved");
      assert.equal(await store.reserveResend("sess-a", "WH-THREE", 3), "reserved");
      assert.equal(await store.reserveResend("sess-a", "WH-FOUR", 3), "cap", "three used");
      assert.equal(await store.reserveResend("sess-b", "WH-ONE", 3), "reserved", "another session has its own count (and its own lock)");
      assert.equal((await store.heals("sess-a")).resends, 3);
      await store.releaseResend("sess-a", "WH-ONE");
      assert.equal((await store.heals("sess-a")).resends, 2);
      assert.equal(await store.reserveResend("sess-a", "WH-ONE", 3), "reserved", "released: the lock and the count are free again");
      assert.equal(await store.reserveResend("sess-a", "WH-FOUR", 3), "cap");
    } finally {
      await done();
    }
  });

  test("shop store: a heal record is kept per event with the session's count beside it", async () => {
    const { store, done } = await make();
    try {
      const record = { eid: "WH-ONE", captureId: "CAPTURE-ONE-0001", kind: "refunded" as const, state: "sent" as const, seen: ["tid-1"], sends: [10], booksBefore: { state: "paid" as const, eid: "WH-0", at: 5 } };
      await store.reserveResend("sess-a", "WH-ONE", 5);
      await store.putHeal("sess-a", record);
      await store.putHeal("sess-a", { ...record, state: "arrived", arrivedAt: 20 });
      await store.putHeal("sess-a", { ...record, eid: "WH-TWO", booksBefore: null });
      const { resends, records } = await store.heals("sess-a");
      assert.equal(resends, 1);
      assert.deepEqual(Object.keys(records).sort(), ["WH-ONE", "WH-TWO"]);
      assert.deepEqual(records["WH-ONE"], { ...record, state: "arrived", arrivedAt: 20 });
      assert.deepEqual(await store.heals("sess-b"), { resends: 0, records: {} });
    } finally {
      await done();
    }
  });

  test("shop store: a report nonce is claimed once; a repeat is refused, another nonce is not", async () => {
    const { store, done } = await make();
    try {
      assert.equal(await store.claimReportNonce("0123456789abcdef", 60_000), true);
      assert.equal(await store.claimReportNonce("0123456789abcdef", 60_000), false);
      assert.equal(await store.claimReportNonce("fedcba9876543210", 60_000), true);
    } finally {
      await done();
    }
  });

  test("shop store: report lines are appended, never overwritten, and an event with no record reads back as null", async () => {
    const { store, done } = await make();
    try {
      await Promise.all(["one", "two", "three"].map((l) => store.appendReport("WH-1", l)));
      const [record, none] = await store.reports(["WH-1", "WH-2"]);
      assert.deepEqual(record?.split("\n").filter(Boolean).sort(), ["one", "three", "two"]);
      assert.equal(none, null);
      assert.deepEqual(await store.reports([]), []);
    } finally {
      await done();
    }
  });
}
