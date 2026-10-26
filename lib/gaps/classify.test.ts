// A4, the unit-test side: the recorded Gate 3 probe logs (fixtures/probe/gap-cases.json: real Sandbox deliveries, event ids and times)
// replayed through the classifier. Four of them are the four classes that cannot be set up live: NO_EVENT_FOUND, NO_REPORT,
// UNSUBSCRIBED_EVENT_TYPE and OUT_OF_ORDER. The rest of the file pins the rules those logs do not show.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttemptReport } from "../shop/reporter.ts";
import type { BookEntry } from "../shop/types.ts";
import { ABSENCE_WINDOW_MS, classify, retriesPendingUntil, ringState, type EventEvidence, type EventKind, type Finding } from "./classify.ts";

interface Check {
  now: number;
  attempts?: { tid: string; receivedAt: number; status: number }[];
  listingRead?: boolean;
  retriesPending?: boolean;
  expect: Partial<Finding> & { waiting?: string };
}
interface Case {
  label: string;
  kind: EventKind;
  actionAt: number;
  eid: string | null;
  d: { at: number } | null;
  listed: { createTime: number } | null;
  listingRead: boolean;
  attempts: { tid: string; receivedAt: number; status: number }[] | null;
  sNoted: boolean;
  subscribed: boolean | undefined;
  books: BookEntry | null;
  checks: Check[];
}

const fixture = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/probe/gap-cases.json"), "utf8")) as { cases: Case[] };
const byLabel = (label: string): Case => {
  const c = fixture.cases.find((x) => x.label === label);
  assert.ok(c, `fixture case ${label}`);
  return c;
};

// The probe receivers logged one line per delivery; as reporter records they are an attempt that arrived and was answered at once.
const asReports = (rows: { tid: string; receivedAt: number; status: number }[] | null): AttemptReport[] | null =>
  rows === null ? null : rows.map((r, i) => ({ tid: r.tid, attempt: `${r.tid}#${i}`, state: "responded" as const, status: r.status, receivedAt: r.receivedAt, respondedAt: r.receivedAt }));

function replay(c: Case, check: Check): { finding: Finding; attempts: AttemptReport[] | null } {
  const attempts = asReports(check.attempts ?? c.attempts);
  const evidence: EventEvidence = {
    kind: c.kind,
    now: check.now,
    actionAt: c.actionAt,
    eid: c.eid,
    d: c.d,
    listed: c.listed,
    listingRead: check.listingRead ?? c.listingRead,
    attempts,
    sNoted: c.sNoted,
    subscribed: c.subscribed,
    books: c.books,
  };
  return { finding: classify(evidence), attempts };
}

function replayAll(label: string): number {
  const c = byLabel(label);
  for (const check of c.checks) {
    const { finding, attempts } = replay(c, check);
    for (const [key, want] of Object.entries(check.expect)) assert.equal((finding as unknown as Record<string, unknown>)[key], want, `${label} @${check.now}: ${key} (${finding.cls} ${finding.flag ?? ""} ${finding.waiting ?? ""})`);
    if (check.retriesPending !== undefined) assert.equal(retriesPendingUntil(attempts, check.now) > check.now, check.retriesPending, `${label} @${check.now}: retries pending`);
    assert.equal(finding.final, finding.cls !== "UNVERIFIED", "final exactly when the class is not UNVERIFIED");
  }
  return c.checks.length;
}

test("A4 fixture 1/4 NO_EVENT_FOUND: a payment PayPal never listed and no webhook was called for is UNVERIFIED for 6 minutes, then NO_EVENT_FOUND; an unreadable list never makes the claim", () => {
  assert.equal(replayAll("P1-2 no event found"), 7);
});

test("A4 fixture 2/4 NO_REPORT: an event PayPal listed and the witness heard, that the shop never reported, is UNVERIFIED until 6 minutes after PayPal made it", () => {
  assert.equal(replayAll("E+5s no report"), 4);
});

test("A4 fixture 3/4 UNSUBSCRIBED_EVENT_TYPE: the shop webhook lacks the type; NO_REPORT with the flag, final at once (no 6-minute wait)", () => {
  assert.equal(replayAll("2c unsubscribed"), 2);
});

test("A4 fixture 4/4 OUT_OF_ORDER: the refund reached the shop 3 s before the payment, which overwrote it; ACKED_BUT_NOT_APPLIED with the flag, after the 10 s settle", () => {
  assert.equal(replayAll("2b out of order"), 3);
});

test("probe logs: the shop answering 500 to every attempt is HANDLER_REJECTING from the first attempt, and PayPal's retries are pending until the third attempt or 3 minutes", () => {
  assert.equal(replayAll("1b handler rejecting"), 4);
});

test("probe logs: the shop answering 200 and dropping the write is ACKED_BUT_NOT_APPLIED after the settle, without the OUT_OF_ORDER flag", () => {
  assert.equal(replayAll("1b ack then drop"), 2);
});

// ---- rules the recorded logs do not show -------------------------------------------------------------------------------

const base: EventEvidence = { kind: "refunded", now: 1_000_000, actionAt: 900_000, eid: "WH-1", d: null, listed: null, listingRead: true, attempts: null, sNoted: false, subscribed: true, books: null };
const attempt = (over: Partial<AttemptReport>): AttemptReport => ({ tid: "t1", attempt: "a1", state: "responded", status: 200, receivedAt: 900_000, respondedAt: 900_500, ...over });

test("witness-based facts are final at once, with no 6-minute wait: S answered 200 and the books differ", () => {
  const f = classify({ ...base, now: 900_500 + 10_000, d: { at: 899_000 }, attempts: [attempt({})] });
  assert.deepEqual([f.cls, f.final], ["ACKED_BUT_NOT_APPLIED", true]);
  assert.equal(classify({ ...base, now: 900_500 + 9_999, d: { at: 899_000 }, attempts: [attempt({})] }).waiting, "settling");
});

test("HANDLER_REJECTING with the CRASHED flag: a delivery that reached the handler and never answered", () => {
  const f = classify({ ...base, attempts: [attempt({ state: "crashed", status: undefined, respondedAt: undefined })] });
  assert.deepEqual([f.cls, f.flag, f.final], ["HANDLER_REJECTING", "CRASHED", true]);
  const mixed = classify({ ...base, attempts: [attempt({ status: 401 }), attempt({ attempt: "a2", state: "crashed", status: undefined, respondedAt: undefined })] });
  assert.deepEqual([mixed.cls, mixed.flag], ["HANDLER_REJECTING", "CRASHED"]);
  const plain = classify({ ...base, attempts: [attempt({ status: 401 })] });
  assert.deepEqual([plain.cls, plain.flag], ["HANDLER_REJECTING", undefined]);
});

test("a delivery that is still being handled is UNVERIFIED, not a verdict", () => {
  const f = classify({ ...base, attempts: [attempt({ state: "in_flight", status: undefined, respondedAt: undefined })] });
  assert.deepEqual([f.cls, f.waiting], ["UNVERIFIED", "handler_working"]);
});

test("a later 2xx beats an earlier failure: the class is decided by what the shop finally answered", () => {
  const f = classify({ ...base, now: 2_000_000, attempts: [attempt({ status: 401 }), attempt({ attempt: "a2", tid: "t2", status: 200, receivedAt: 1_500_000, respondedAt: 1_500_200 })] });
  assert.equal(f.cls, "ACKED_BUT_NOT_APPLIED");
});

test("OUT_OF_ORDER needs the books to be 'paid', written by another event after the refund had reached the shop", () => {
  const refundAt = 900_000;
  const paidBook = (eid: string, at: number): BookEntry => ({ state: "paid", amount: "48.00", eid, at });
  const common = { ...base, now: 5_000_000, attempts: [attempt({ receivedAt: refundAt, respondedAt: refundAt + 300 })] };
  assert.equal(classify({ ...common, books: paidBook("WH-PAID", refundAt + 3000) }).flag, "OUT_OF_ORDER");
  assert.equal(classify({ ...common, books: paidBook("WH-PAID", refundAt - 60_000) }).flag, undefined, "paid before the refund arrived: the refund was simply not applied");
  assert.equal(classify({ ...common, books: paidBook("WH-1", refundAt + 3000) }).flag, undefined, "written by this very event");
  assert.equal(classify({ ...common, books: null }).flag, undefined);
});

test("absence claims are never made inside the window, from any starting point, and the same evidence turns into a claim exactly at 6 minutes", () => {
  const exists = { ...base, d: { at: 100_000 }, listed: { createTime: 90_000 } };
  for (const dt of [0, 1, 60_000, ABSENCE_WINDOW_MS - 1]) assert.equal(classify({ ...exists, now: 90_000 + dt }).cls, "UNVERIFIED", `NO_REPORT at +${dt}`);
  assert.equal(classify({ ...exists, now: 90_000 + ABSENCE_WINDOW_MS }).cls, "NO_REPORT");
  const nothing = { ...base, actionAt: 50_000 };
  for (const dt of [0, 1, 60_000, ABSENCE_WINDOW_MS - 1]) assert.equal(classify({ ...nothing, now: 50_000 + dt }).cls, "UNVERIFIED", `NO_EVENT_FOUND at +${dt}`);
  assert.equal(classify({ ...nothing, now: 50_000 + ABSENCE_WINDOW_MS }).cls, "NO_EVENT_FOUND");
});

test("the window starts at PayPal's own creation time when the list has it, otherwise when the witness heard it", () => {
  const d = classify({ ...base, d: { at: 1_000_000 - 5 * 60_000 }, now: 1_000_000 });
  assert.equal(d.cls, "UNVERIFIED");
  const l = classify({ ...base, d: { at: 1_000_000 - 5 * 60_000 }, listed: { createTime: 1_000_000 - 7 * 60_000 }, now: 1_000_000 });
  assert.equal(l.cls, "NO_REPORT");
});

test("S noting a delivery without a reporter record is not an absence", () => {
  const f = classify({ ...base, d: { at: 1_000 }, now: 100_000_000, sNoted: true });
  assert.deepEqual([f.cls, f.waiting], ["UNVERIFIED", "reporter_record_missing"]);
});

// ---- Ring again ---------------------------------------------------------------------------------------------------------

const acked: Finding = { cls: "ACKED_BUT_NOT_APPLIED", final: true, why: "" };
const ring = (over: Partial<Parameters<typeof ringState>[0]> = {}) => ringState({ finding: acked, eid: "WH-1", listed: true, retriesUntil: 0, inFlight: false, resendsUsed: 0, now: 1_000, ...over });

test("ring: ready only for a final class with a listed event, no retries pending, nothing in flight and resends left", () => {
  assert.equal(ring().state, "ready");
  assert.equal(ring({ finding: { cls: "HANDLER_REJECTING", final: true, why: "" } }).state, "ready");
  assert.equal(ring({ finding: { cls: "UNVERIFIED", final: false, why: "", waiting: "absence_window", untilMs: 5_000 } }).state, "wait");
  assert.equal(ring({ finding: { cls: "NO_EVENT_FOUND", final: true, why: "" } }).state, "cannot_heal");
  assert.equal(ring({ listed: false }).state, "not_listed", "a gap whose event is not in the list cannot be healed");
  assert.equal(ring({ eid: null, listed: false }).state, "not_listed");
  assert.equal(ring({ retriesUntil: 2_000 }).state, "retries_pending");
  assert.equal(ring({ retriesUntil: 1_000 }).state, "ready", "retries that ended at this very moment are over");
  assert.equal(ring({ inFlight: true }).state, "in_progress");
  assert.equal(ring({ resendsUsed: 5 }).state, "cap_reached");
});

test("ring: the order of the reasons is stable (not listed beats retries pending beats the cap)", () => {
  assert.equal(ring({ listed: false, retriesUntil: 9_000, resendsUsed: 5 }).state, "not_listed");
  assert.equal(ring({ retriesUntil: 9_000, resendsUsed: 5 }).state, "retries_pending");
});

test("retries pending: counted per transmission id, over when a 2xx came, three attempts were made, or 3 minutes passed", () => {
  const a = (tid: string, at: number, status: number) => attempt({ tid, attempt: `${tid}@${at}`, receivedAt: at, respondedAt: at + 100, status });
  assert.equal(retriesPendingUntil(null, 0), 0);
  assert.equal(retriesPendingUntil([a("t", 0, 401)], 60_000), 180_000);
  assert.equal(retriesPendingUntil([a("t", 0, 401)], 180_000), 0);
  assert.equal(retriesPendingUntil([a("t", 0, 401), a("t", 34_000, 401), a("t", 160_000, 401)], 161_000), 0, "three attempts is all a Sandbox delivery gets");
  assert.equal(retriesPendingUntil([a("t", 0, 401), a("t", 34_000, 200)], 40_000), 0);
  assert.equal(retriesPendingUntil([a("t", 0, 200)], 1_000), 0, "an acknowledged delivery is never retried");
  assert.equal(retriesPendingUntil([a("old", 0, 401), a("old", 34_000, 401), a("old", 160_000, 401), a("resent", 300_000, 500)], 310_000), 480_000, "a resent delivery that failed has retries of its own");
});
