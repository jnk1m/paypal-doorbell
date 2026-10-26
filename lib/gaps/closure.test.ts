// How a TIED row with no arrived resend of ours was closed: read from the tries of the event that last wrote the books, with the time of that write inside the closing try, never from the lane's memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AttemptReport } from "../shop/reporter.ts";
import { ALL_RECORDED_SCENARIOS, recordedScenario } from "../run/recorded.ts";
import { closureOf, healArrived } from "./closure.ts";
import type { ScanEvent, ScanRow } from "./scan.ts";

const T0 = 1_792_487_000_000;
const RETRY = "tid-retry";
const NEW = "tid-new";

const attempt = (id: string, tid: string, at: number, status?: number): AttemptReport => (status === undefined ? { tid, attempt: id, state: "crashed", receivedAt: at } : { tid, attempt: id, state: "responded", receivedAt: at, status, respondedAt: at + 200 });
const inFlight = (id: string, tid: string, at: number): AttemptReport => ({ tid, attempt: id, state: "in_flight", receivedAt: at });
const event = (s: AttemptReport[], o: Partial<ScanEvent> = {}): ScanEvent => ({ kind: "refunded", resourceId: "R1", eid: "WH-refund", d: null, s, listed: true, finding: null, ring: null, heal: null, ...o });
const booked = (at: number, eid = "WH-refund"): ScanRow["book"] => ({ state: "refunded", amount: "48.00", eid, at });
const row = (events: ScanEvent[], o: Partial<ScanRow> = {}): ScanRow => ({ n: 2, captureId: "C2", itemName: "Gift set", amount: "48.00", status: "TIED", truth: "refunded", paypalStatus: "REFUNDED", refundStatus: "COMPLETED", book: booked(T0 + 100), events, ...o });
// A row whose books were written 100 ms into the first 2xx try of these tries: the plain case, so a test changes one thing.
const closedRow = (tries: AttemptReport[], o: Partial<ScanRow> = {}): ScanRow => row([event(tries)], { book: booked(tries.find((a) => a.status !== undefined && a.status < 300)!.receivedAt! + 100), ...o });

test("401, 401, then 200 on the same transmission id: PayPal's own retry closed the row", () => {
  const z = closureOf(closedRow([attempt("a", RETRY, T0, 401), attempt("b", RETRY, T0 + 35_000, 401), attempt("c", RETRY, T0 + 161_000, 200)]))!;
  assert.equal(z.kind, "paypal_retry");
  assert.equal(z.event, "refunded");
  assert.equal(z.tryNo, 3);
  assert.equal(z.sinceFirstSec, 161);
  assert.equal(z.at, T0 + 161_000);
  assert.equal(z.status, 200);
  assert.deepEqual(z.failed, [401, 401]);
});

test("the tries are read in the order they arrived, not the order they are listed", () => {
  const z = closureOf(closedRow([attempt("c", RETRY, T0 + 161_000, 200), attempt("a", RETRY, T0, 401), attempt("b", RETRY, T0 + 35_000, 401)]))!;
  assert.equal(z.tryNo, 3);
  assert.deepEqual(z.failed, [401, 401]);
});

test("a 401 and then a 200 on a new transmission id: a delivery nobody here asked for", () => {
  const z = closureOf(closedRow([attempt("a", RETRY, T0, 401), attempt("b", NEW, T0 + 90_000, 200)]))!;
  assert.equal(z.kind, "other_delivery");
  assert.equal(z.tryNo, 2);
  assert.equal(z.sinceFirstSec, 90);
});

test("a crash before the 2xx counts as a failed try", () => {
  const z = closureOf(closedRow([attempt("a", RETRY, T0), attempt("b", RETRY, T0 + 40_000, 200)]))!;
  assert.equal(z.kind, "paypal_retry");
  assert.deepEqual(z.failed, [null]);
});

test("a 500 and then a 200 is read like a 401: the status family does not matter", () => {
  const z = closureOf(closedRow([attempt("a", RETRY, T0, 500), attempt("b", RETRY, T0 + 35_000, 200)]))!;
  assert.equal(z.kind, "paypal_retry");
  assert.deepEqual(z.failed, [500]);
});

test("200 and 200: nothing failed first, so nothing is said about how the row closed", () => {
  assert.equal(closureOf(closedRow([attempt("a", RETRY, T0, 200), attempt("b", NEW, T0 + 9_000, 200)])), null);
});

test("a row that is not TIED has no closure", () => {
  const tries = [attempt("a", RETRY, T0, 401), attempt("b", RETRY, T0 + 35_000, 200)];
  for (const status of ["GAP", "UNVERIFIED"] as const) assert.equal(closureOf(closedRow(tries, { status })), null, status);
});

// ---- the write must fall inside the closing try ----------------------------------------------------------------------------------------

test("the books were written inside the closing try's receive-to-answer window, ends included; outside it the row is not described", () => {
  const tries = [attempt("a", RETRY, T0, 500), attempt("b", RETRY, T0 + 35_000, 200)]; // the closing try is [T0 + 35_000, T0 + 35_200]
  const at = (t: number) => closureOf(row([event(tries)], { book: booked(t) }));
  assert.equal(at(T0 + 35_000)?.kind, "paypal_retry", "at the moment it was received");
  assert.equal(at(T0 + 35_200)?.kind, "paypal_retry", "at the moment it was answered");
  assert.equal(at(T0 + 34_999), null, "a write just before the closing try arrived was somebody else's");
  assert.equal(at(T0 + 35_201), null, "a write just after it was answered was somebody else's");
  assert.equal(at(T0 + 100), null, "a write inside the failed first try");
  assert.equal(at(T0 + 200_000), null, "a write long after every try");
});

test("when two 2xx tries both contain the write, the earlier one is the closing try", () => {
  const z = closureOf(row([event([attempt("a", RETRY, T0, 401), attempt("b", RETRY, T0 + 10_000, 200), attempt("c", NEW, T0 + 10_100, 200)])], { book: booked(T0 + 10_150) }))!;
  assert.equal(z.tryNo, 2);
  assert.equal(z.at, T0 + 10_000);
});

// ---- the earlier tries must all be plain failures --------------------------------------------------------------------------------------

test("an earlier try still in flight leaves the row undecided", () => {
  assert.equal(closureOf(closedRow([attempt("a", RETRY, T0, 401), inFlight("b", RETRY, T0 + 5_000), attempt("c", RETRY, T0 + 35_000, 200)])), null);
});

test("an earlier 2xx try (the OUT_OF_ORDER shape) is not a closure: the books were written by something else", () => {
  assert.equal(closureOf(row([event([attempt("a", RETRY, T0, 200), attempt("b", NEW, T0 + 35_000, 200)])], { book: booked(T0 + 35_100) })), null);
  assert.equal(closureOf(row([event([attempt("a", RETRY, T0, 200), attempt("b", RETRY, T0 + 20_000, 401), attempt("c", RETRY, T0 + 35_000, 200)])], { book: booked(T0 + 35_100) })), null);
});

test("a try that arrived after the closing one does not matter", () => {
  const z = closureOf(row([event([attempt("a", RETRY, T0, 500), attempt("b", RETRY, T0 + 35_000, 200), attempt("c", NEW, T0 + 70_000, 500)])], { book: booked(T0 + 35_100) }))!;
  assert.equal(z.tryNo, 2);
  assert.deepEqual(z.failed, [500]);
});

// ---- a resend of ours -----------------------------------------------------------------------------------------------------------------

const RETRIED = [attempt("a", RETRY, T0, 401), attempt("b", RETRY, T0 + 35_000, 200)];

test("a heal record WITHOUT the resend's arrival is ignored: PayPal's own retry closed the row", () => {
  for (const heal of [{ state: "healed" as const, sends: 1 }, { state: "sent" as const, sends: 1, sentAt: [T0 + 20_000] }, { state: "lost" as const, sends: 3 }]) {
    const z = closureOf(closedRow(RETRIED, { events: [event(RETRIED, { heal })] }))!;
    assert.equal(z.kind, "paypal_retry", heal.state);
  }
});

test("a heal record WITH the resend's arrival is the ring's, not a closure, whatever its state and whichever event carries it", () => {
  for (const state of ["healed", "arrived", "unchanged"] as const) {
    const heal = { state, sends: 1, sentAt: [T0 + 20_000], arrivedAt: T0 + 23_000 };
    assert.equal(closureOf(closedRow(RETRIED, { events: [event(RETRIED, { heal })] })), null, state);
    assert.equal(closureOf(closedRow(RETRIED, { events: [event(RETRIED), event([], { kind: "completed", eid: "WH-pay", heal })] })), null, `${state} on the other event`);
  }
});

test("healArrived reads only a finite arrivedAt", () => {
  assert.equal(healArrived({ state: "healed", sends: 1, arrivedAt: T0 }), true);
  for (const h of [null, undefined, { state: "healed" as const, sends: 1 }, { state: "healed" as const, sends: 1, arrivalSeconds: 3.3 }, { state: "healed" as const, sends: 1, arrivedAt: Number.NaN }, { state: "healed" as const, sends: 1, arrivedAt: "7" as never }]) assert.equal(healArrived(h), false);
});

// ---- the event that wrote the books ----------------------------------------------------------------------------------------------------

test("only the event that wrote the books counts, and a row whose books have no entry has none", () => {
  assert.equal(closureOf(closedRow(RETRIED, { book: booked(T0 + 35_100, "WH-other") })), null, "the books were last written by another event");
  assert.equal(closureOf(closedRow(RETRIED, { book: null })), null);
  // the payment event failed once and the refund event did not: the refund wrote the books, so there is no failed try to speak of
  const payment = event([attempt("p1", NEW, T0 - 50_000, 500), attempt("p2", NEW, T0 - 10_000, 200)], { kind: "completed", eid: "WH-pay" });
  assert.equal(closureOf(row([payment, event([attempt("r", RETRY, T0, 200)])], { book: booked(T0 + 100) })), null);
  assert.equal(closureOf(row([event(null as unknown as AttemptReport[])])), null, "no report at all");
});

test("the payment event can be the one that closed the row", () => {
  const payment = event([attempt("p1", RETRY, T0, 502), attempt("p2", RETRY, T0 + 40_000, 200)], { kind: "completed", eid: "WH-pay" });
  const z = closureOf(row([payment], { book: { state: "paid", amount: "48.00", eid: "WH-pay", at: T0 + 40_050 }, truth: "paid" }))!;
  assert.equal(z.event, "completed");
  assert.deepEqual(z.failed, [502]);
});

// ---- a malformed row is silence, not an exception ---------------------------------------------------------------------------------------

test("a malformed row gives null and never throws", () => {
  const good = closedRow(RETRIED);
  assert.ok(closureOf(good), "the unbroken row does close");
  const broken: [string, unknown][] = [
    ["no row", null],
    ["events is not an array", { ...good, events: "nope" }],
    ["events is missing", { ...good, events: undefined }],
    ["an event is null", { ...good, events: [null, event(RETRIED)] }],
    ["s is missing", { ...good, events: [event(RETRIED, { s: undefined as never })] }],
    ["s is not an array", { ...good, events: [event(RETRIED, { s: { length: 2 } as never })] }],
    ["book.at is not a number", { ...good, book: { ...good.book, at: "soon" } }],
    ["book.at is NaN", { ...good, book: { ...good.book, at: Number.NaN } }],
    ["book is a string", { ...good, book: "paid" }],
    ["book.eid is missing", { ...good, book: { ...good.book, eid: undefined } }],
    ["status is missing", { ...good, status: undefined }],
    ["a try is null", { ...good, events: [event([null as never, ...RETRIED])] }],
    ["a try has no time", { ...good, events: [event([{ tid: RETRY, attempt: "x", state: "responded", status: 401 } as never, RETRIED[1]])] }],
    ["a try has no tid", { ...good, events: [event([{ attempt: "x", state: "crashed", receivedAt: T0 } as never, RETRIED[1]])] }],
    ["a try is answered with no status", { ...good, events: [event([{ tid: RETRY, attempt: "x", state: "responded", receivedAt: T0, respondedAt: T0 + 5 } as never, RETRIED[1]])] }],
    ["a try has a state nobody knows", { ...good, events: [event([{ tid: RETRY, attempt: "x", state: "stuck", receivedAt: T0 } as never, RETRIED[1]])] }],
    ["the event kind is unknown", { ...good, events: [event(RETRIED, { kind: "other" as never })] }],
  ];
  for (const [what, r] of broken) assert.equal(closureOf(r as ScanRow), null, what);
});

// ---- the real recordings -------------------------------------------------------------------------------------------------------------

test("in the six real recordings the only row PayPal's own retry closed is order 1 of signature_rejected, in all four steps", () => {
  const found: string[] = [];
  for (const sc of ALL_RECORDED_SCENARIOS) {
    sc.steps.forEach((st, i) => {
      for (const r of st.scan?.rows ?? []) {
        const z = closureOf(r);
        if (z) found.push(`${sc.id}/step${i + 1}/n${r.n}/${z.kind}`);
      }
    });
  }
  assert.deepEqual(found, [1, 2, 3, 4].map((i) => `signature_rejected/step${i}/n1/paypal_retry`));
});

test("signature_rejected order 1: a 500, then a 200 on the same transmission id about 35 s later, as try 2", () => {
  const sc = recordedScenario("signature_rejected");
  for (const st of sc.steps) {
    const r = st.scan!.rows.find((x) => x.n === 1)!;
    const z = closureOf(r)!;
    assert.equal(z.kind, "paypal_retry");
    assert.equal(z.event, "completed");
    assert.deepEqual(z.failed, [500]);
    assert.equal(z.tryNo, 2);
    assert.ok(z.sinceFirstSec >= 34 && z.sinceFirstSec <= 36, `${z.sinceFirstSec} s`);
    assert.equal(z.status, 200);
  }
});
