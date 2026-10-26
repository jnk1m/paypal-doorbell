// R9 / A9: the stamp truth table, the header against the table, no model or scan string in the output, no forbidden word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding, Waiting } from "../gaps/classify.ts";
import type { HealView, RowStatus, ScanEvent, ScanResult, ScanRow } from "../gaps/scan.ts";
import type { AttemptReport } from "../shop/reporter.ts";
import { certificateOf, fromMinor, LIST_LAG_MS, rowsInsideListLag, toMinor } from "./cert.ts";
import * as templates from "./templates.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- builders ---------------------------------------------------------------------------------------------------------------------
const finding = (cls: Finding["cls"], over: Partial<Finding> = {}): Finding => ({ cls, final: cls !== "UNVERIFIED", why: "fixture", ...over });

function event(kind: "completed" | "refunded", f: Finding | null): ScanEvent {
  return { kind, resourceId: "RES0000000001", eid: "WH-FIXTURE-0001", d: null, s: null, listed: false, finding: f, ring: null, heal: null };
}

// How a TIED row can carry tries and a heal record (lib/gaps/closure.ts reads them). `earlier` is the number of tries before the closing one when PayPal's
// own retry closed the row (the same transmission id, the shop did not take the earlier tries, no resend of ours arrived), else 0; `healed` is whether a resend
// of ours arrived and the books then matched.
const T0 = 1_792_487_000_000;
const tryOf = (id: string, tid: string, at: number, status: number): AttemptReport => ({ tid, attempt: id, state: "responded", receivedAt: at, status, respondedAt: at + 200 });
const SENT: HealView = { state: "healed", sends: 1, sentAt: [T0 + 20_000] };
const SHAPES = {
  plain: { tries: [tryOf("a", "t1", T0, 200)], heal: null, earlier: 0, healed: false },
  retry: { tries: [tryOf("a", "t1", T0, 500), tryOf("b", "t1", T0 + 35_000, 200)], heal: null, earlier: 1, healed: false },
  retry_two: { tries: [tryOf("a", "t1", T0, 401), tryOf("b", "t1", T0 + 35_000, 401), tryOf("c", "t1", T0 + 161_000, 200)], heal: null, earlier: 2, healed: false },
  new_tid: { tries: [tryOf("a", "t1", T0, 401), tryOf("b", "t2", T0 + 90_000, 200)], heal: null, earlier: 0, healed: false },
  healed_arrived: { tries: [tryOf("a", "t1", T0, 401), tryOf("b", "t1", T0 + 35_000, 200)], heal: { ...SENT, arrivedAt: T0 + 23_000 }, earlier: 0, healed: true },
  healed_unarrived: { tries: [tryOf("a", "t1", T0, 200)], heal: SENT, earlier: 0, healed: false },
  healed_unarrived_retry: { tries: [tryOf("a", "t1", T0, 500), tryOf("b", "t1", T0 + 35_000, 200)], heal: SENT, earlier: 1, healed: false },
  in_flight: { tries: [tryOf("a", "t1", T0, 401), { tid: "t1", attempt: "x", state: "in_flight", receivedAt: T0 + 20_000 }, tryOf("b", "t1", T0 + 35_000, 200)], heal: null, earlier: 0, healed: false },
} satisfies Record<string, { tries: AttemptReport[]; heal: HealView | null; earlier: number; healed: boolean }>;
type Shape = keyof typeof SHAPES;

// The books of a shaped row were written 100 ms into its last 2xx try, by the event that carries the tries.
function shapedParts(shape: Shape, amount: string): Pick<ScanRow, "book" | "events"> {
  const { tries, heal } = SHAPES[shape];
  const closing = [...tries].reverse().find((a) => a.status !== undefined && a.status < 300)!;
  return { book: { state: "paid", amount, eid: "WH-FIXTURE-0001", at: closing.receivedAt! + 100 }, events: [{ ...event("completed", null), s: tries, heal }] };
}

interface RowSpec {
  status: RowStatus;
  amount?: string;
  truth?: "paid" | "refunded" | null;
  waiting?: Waiting;
  cls?: Finding["cls"];
  kind?: "completed" | "refunded";
  shape?: Shape; // a TIED row with tries (and perhaps a heal record) that closure.ts can read
}
function rowOf(n: number, spec: RowSpec): ScanRow {
  const f = spec.status === "GAP" ? finding(spec.cls ?? "ACKED_BUT_NOT_APPLIED") : null;
  const shaped = spec.status === "TIED" && spec.shape ? shapedParts(spec.shape, spec.amount ?? "48.00") : null;
  return {
    n,
    captureId: `CAPTURE${String(n).padStart(8, "0")}`,
    itemName: "Gift set",
    amount: spec.amount ?? "48.00",
    status: spec.status,
    ...(spec.waiting ? { waiting: spec.waiting } : {}),
    truth: spec.truth === undefined ? (spec.status === "UNVERIFIED" ? null : spec.status === "GAP" ? "refunded" : "paid") : spec.truth,
    paypalStatus: "REFUNDED",
    refundStatus: null,
    book: shaped?.book ?? null,
    events: shaped?.events ?? (f ? [event(spec.kind ?? "refunded", f)] : []),
  };
}

function scanOf(specs: RowSpec[], over: Partial<ScanResult> = {}): ScanResult {
  const rows = specs.map((s, i) => rowOf(i + 1, s));
  return {
    session: { id: "0".repeat(32), mode: "ack_then_drop" },
    at: 1_800_000_000_000,
    durationMs: 2_800,
    deadlineHit: false,
    rows,
    summary: { rows: rows.length, tied: rows.filter((r) => r.status === "TIED").length, gaps: rows.filter((r) => r.status === "GAP").length, unverified: rows.filter((r) => r.status === "UNVERIFIED").length, byClass: {} },
    listing: { asked: true, read: true, events: 0 },
    calls: { captures: rows.length, refunds: 0, retries: 0 },
    resendsUsed: 0,
    reverify: undefined,
    ...over,
  };
}

const many = (n: number, spec: RowSpec): RowSpec[] => Array.from({ length: n }, () => spec);
const TIED: RowSpec = { status: "TIED" };
const GAP: RowSpec = { status: "GAP" };
const UNV: RowSpec = { status: "UNVERIFIED", waiting: "settling" };

// ---- A9: the stamp truth table, 12 cases ------------------------------------------------------------------------------------------
const TABLE: { name: string; specs: RowSpec[]; stamp: "green" | "amber" | "red"; text: string }[] = [
  { name: "41 rows, all agree", specs: many(41, TIED), stamp: "green", text: "Tied on 41/41 of what we can see" },
  { name: "one row, agrees", specs: [TIED], stamp: "green", text: "Tied on 1/1 of what we can see" },
  { name: "38 agree, 3 too new", specs: [...many(38, TIED), ...many(3, UNV)], stamp: "amber", text: "Tied on 38/41 · 3 unverified" },
  { name: "one row, unverified", specs: [UNV], stamp: "amber", text: "Tied on 0/1 · 1 unverified" },
  { name: "all rows unverified", specs: many(5, { status: "UNVERIFIED", waiting: "requery_failed" }), stamp: "amber", text: "Tied on 0/5 · 5 unverified" },
  { name: "no rows at all", specs: [], stamp: "amber", text: "Nothing checked yet" },
  { name: "40 agree, 1 unverified", specs: [...many(40, TIED), UNV], stamp: "amber", text: "Tied on 40/41 · 1 unverified" },
  { name: "one gap among 41", specs: [...many(40, TIED), GAP], stamp: "red", text: "1 gap · Tied on 40/41" },
  { name: "one row, a gap", specs: [GAP], stamp: "red", text: "1 gap · Tied on 0/1" },
  { name: "two gaps, nothing else", specs: many(2, GAP), stamp: "red", text: "2 gaps · Tied on 0/2" },
  { name: "a gap and unverified rows", specs: [...many(5, TIED), ...many(2, GAP), ...many(3, UNV)], stamp: "red", text: "2 gaps · Tied on 5/10 · 3 unverified" },
  { name: "a gap beside a row PayPal did not answer for", specs: [GAP, { status: "UNVERIFIED", waiting: "requery_failed" }], stamp: "red", text: "1 gap · Tied on 0/2 · 1 unverified" },
];

test("A9: the stamp truth table, 12 cases: green only at coverage 100%, unverified 0 and gaps 0; amber with no gap but something unchecked; red at any gap", () => {
  assert.equal(TABLE.length, 12);
  let right = 0;
  for (const c of TABLE) {
    const cert = certificateOf(scanOf(c.specs));
    assert.equal(cert.stamp, c.stamp, c.name);
    assert.equal(cert.stampText, c.text, c.name);
    // The rule, restated from the numbers the certificate itself reports.
    const n = cert.numbers;
    const expected = n.gaps > 0 ? "red" : n.coveragePct === 100 && n.unverified === 0 && n.rows > 0 ? "green" : "amber";
    assert.equal(cert.stamp, expected, `${c.name}: the stamp follows from the numbers`);
    right++;
  }
  assert.equal(right, 12, "12/12");
});

test("A9: the certificate says it is not signed, carries the standing footnote, and its owner view ends with the two plain limits", () => {
  const cert = certificateOf(scanOf([...many(2, TIED), GAP]));
  assert.equal(cert.signed, false);
  assert.equal(cert.footnote, templates.FOOTNOTE);
  assert.match(cert.footnote, /not signed/);
  assert.match(cert.footnote, /97-128 minutes/);
  assert.equal(cert.ownerView.at(-2), templates.owner.limit());
  assert.equal(cert.ownerView.at(-1), templates.owner.unsigned());
  assert.equal(cert.scopeAt, 1_800_000_000_000);
});

test("the header leads with what was found, then the money and the coverage; a run that found nothing leads with the coverage", () => {
  const specs: RowSpec[] = [...many(38, TIED), ...many(3, UNV)];
  assert.equal(certificateOf(scanOf(specs)).header, "Checked 38 of 41 captures (92%) · 3 too new to verify.");
  const red = certificateOf(scanOf([...many(39, TIED), GAP, GAP]));
  assert.equal(red.header, "2 of 41 captures did not match PayPal (2 answered OK but the books do not match PayPal) · $96.00 across 2 refunds not in books · checked 41 of 41 captures.");
  assert.ok(!red.header.startsWith("Checked"), "100% coverage is not the headline over two gaps");
  assert.ok(!red.header.includes("%"), "no percentage next to a gap");
  assert.equal(red.numbers.moneyNotInBooks, "96.00");
  assert.equal(red.numbers.refundsNotInBooks, 2);
  assert.equal(red.numbers.byClass.ACKED_BUT_NOT_APPLIED, 2);
  const missing = certificateOf(scanOf([{ status: "GAP", cls: "NO_REPORT", kind: "refunded" }, { status: "GAP", cls: "NO_EVENT_FOUND", kind: "completed", truth: "paid" }]));
  assert.match(missing.header, /webhook missing REFUNDED on 1/);
  assert.match(missing.header, /\$96\.00 across 1 refund and 1 payment not in books/);
  assert.ok(missing.limits.some((l) => /^1 event could not be found/.test(l)), "NO_EVENT_FOUND is a limit, with its number");
});

test("money is summed in minor units: 0.10 + 0.20 is 0.30, not 0.30000000000000004", () => {
  const cert = certificateOf(scanOf([{ status: "GAP", amount: "0.10" }, { status: "GAP", amount: "0.20" }, { status: "GAP", amount: "0.07" }]));
  assert.equal(cert.numbers.moneyNotInBooks, "0.37");
  assert.equal(toMinor("48.00"), 4800);
  assert.equal(toMinor("48"), null);
  assert.equal(toMinor("-1.00"), null);
  assert.equal(toMinor("1e3"), null);
  assert.equal(fromMinor(5), "0.05");
  assert.equal(fromMinor(123456789), "1234567.89");
  const odd = certificateOf(scanOf([{ status: "GAP", amount: "not money" }, { status: "GAP", amount: "5.00" }]));
  assert.equal(odd.numbers.moneyNotInBooks, "5.00", "an amount that cannot be read is left out ...");
  assert.ok(odd.limits.some((l) => l.startsWith("1 amount could not be read")), "... and said so");
});

test("the limits of this run carry their numbers: too new, re-query failures, the list lag, a hit deadline, an unread list", () => {
  const cert = certificateOf(
    scanOf([...many(2, { status: "UNVERIFIED", waiting: "absence_window" }), { status: "UNVERIFIED", waiting: "requery_failed" }, { status: "UNVERIFIED", waiting: "status_not_modeled" }, TIED], { deadlineHit: true, durationMs: 10_040, listing: { asked: true, read: false, events: 0 } }),
    { rowsInsideListLag: 4 },
  );
  assert.deepEqual(cert.limits, [
    "2 rows are too new to verify: the books get 10 s after the shop answers, and an event that is absent needs 6 minutes before it can be called missing.",
    "4 rows are inside PayPal's event-list lag (median about 80 s, up to 163 s measured): an event missing from the list proves nothing yet.",
    "1 re-query of PayPal failed after one retry; that row stays unverified.",
    "1 row shows a PayPal state that the shop has no entry for, so it is not compared.",
    "The scan stopped waiting for PayPal after 10.0 s; rows it had not reached are unverified.",
    "PayPal's event list could not be read this time, so rows that depend on it stay unverified.",
  ]);
  assert.deepEqual(certificateOf(scanOf(many(3, TIED))).limits, [], "a run with nothing in the way lists no row-level limit");
});

test("rowsInsideListLag counts the orders whose last action is younger than the list lag", () => {
  const at = 1_800_000_000_000;
  assert.equal(rowsInsideListLag([{ at: at - 10_000, refundAt: null }, { at: at - 900_000, refundAt: at - 60_000 }, { at: at - 900_000, refundAt: null }, { at: at - LIST_LAG_MS, refundAt: null }], at), 2);
});

// ---- A9: the header numbers are the table's sums, for random scans ---------------------------------------------------------------
function prng(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const CLASSES: Finding["cls"][] = ["ACKED_BUT_NOT_APPLIED", "HANDLER_REJECTING", "NO_REPORT", "NO_EVENT_FOUND"];
const WAITING: Waiting[] = ["settling", "absence_window", "handler_working", "requery_failed", "status_not_modeled", "listing_unavailable", "reporter_record_missing"];

// A random scan. Some tied rows carry tries (and heal records without the resend's arrival) as a closed row would; with `healed` some also carry a healed
// ring whose resend arrived, which changes the header's lead (found = gaps + healed), so the tests of the lead leave it off. `shapes[i]` is row i's shape.
function randomScanShaped(rand: () => number, healed: boolean): { scan: ScanResult; shapes: (Shape | null)[] } {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const shapeNames = (Object.keys(SHAPES) as Shape[]).filter((s) => healed || s !== "healed_arrived");
  const n = Math.floor(rand() * 60);
  const shapes: (Shape | null)[] = [];
  const specs: RowSpec[] = Array.from({ length: n }, () => {
    const r = rand();
    const amount = `${Math.floor(rand() * 500)}.${String(Math.floor(rand() * 100)).padStart(2, "0")}`;
    if (r < 0.5) {
      const shape = rand() < 0.4 ? pick(shapeNames) : null;
      shapes.push(shape);
      return { status: "TIED", amount, ...(shape ? { shape } : {}) };
    }
    shapes.push(null);
    if (r < 0.75) return { status: "GAP", amount, cls: pick(CLASSES), kind: pick(["completed", "refunded"] as const), truth: pick(["paid", "refunded"] as const) };
    return { status: "UNVERIFIED", amount, waiting: pick(WAITING) };
  });
  return { scan: scanOf(specs), shapes };
}
const randomScan = (rand: () => number): ScanResult => randomScanShaped(rand, false).scan;

test("A9: for 500 random scans the header's numbers are the table's sums (rows, checked, tied, gaps, unverified, percent, money in cents, refund count)", () => {
  const rand = prng(20261019);
  let mismatches = 0;
  for (let i = 0; i < 500; i++) {
    const scan = randomScan(rand);
    const cert = certificateOf(scan);
    const t = scan.rows.filter((r) => r.status === "TIED").length;
    const g = scan.rows.filter((r) => r.status === "GAP");
    const u = scan.rows.filter((r) => r.status === "UNVERIFIED").length;
    const cents = g.reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0);
    const refunds = g.filter((r) => r.truth === "refunded").length;
    const pct = scan.rows.length === 0 ? 0 : Math.floor(((t + g.length) * 100) / scan.rows.length);
    const n = cert.numbers;
    const same = n.rows === scan.rows.length && n.tied === t && n.gaps === g.length && n.unverified === u && n.checked === t + g.length && n.coveragePct === pct && n.moneyNotInBooks === `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}` && n.refundsNotInBooks === refunds;
    const noun = scan.rows.length === 1 ? "capture" : "captures";
    const inHeader =
      scan.rows.length === 0
        ? cert.header.startsWith("Nothing checked yet")
        : g.length === 0
          ? cert.header.startsWith(`Checked ${t + g.length} of ${scan.rows.length} ${noun} (${pct}%)`)
          : cert.header.startsWith(`${g.length} of ${scan.rows.length} ${noun} did not match PayPal`) && cert.header.includes(`checked ${t + g.length} of ${scan.rows.length} ${noun}`) && (cents === 0 || cert.header.includes(`$${n.moneyNotInBooks} across `));
    if (!same || !inHeader) mismatches++;
    assert.equal(t + g.length + u, scan.rows.length, "every row is counted once");
    assert.equal(cert.stamp, g.length > 0 ? "red" : scan.rows.length > 0 && u === 0 ? "green" : "amber");
  }
  assert.equal(mismatches, 0, "header numbers equal the table's sums in every one of 500 random scans");
});

// ---- A9: a string injected anywhere in the scan never reaches the certificate ----------------------------------------------------
const MARKER = "MARKER-zq7x-INJECTED";

// Every path to a string leaf of a value.
function stringPaths(value: unknown, path: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] {
  if (typeof value === "string") out.push(path);
  else if (Array.isArray(value)) value.forEach((v, i) => stringPaths(v, [...path, i], out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) stringPaths(v, [...path, k], out);
  return out;
}
function withLeaf<T>(value: T, path: (string | number)[], leaf: string): T {
  const copy = structuredClone(value) as Record<string | number, unknown>;
  let at: Record<string | number, unknown> = copy;
  for (const p of path.slice(0, -1)) at = at[p] as Record<string | number, unknown>;
  at[path[path.length - 1]] = leaf;
  return copy as T;
}

// A scan that has a value in every place the real one has a string: ids, names, a "why", a flag, a heal state, the book, the reporter's attempts.
function richScan(): ScanResult {
  const f = (cls: Finding["cls"], kind: "completed" | "refunded"): ScanEvent => ({
    kind,
    resourceId: "RESOURCE-ID-0001",
    eid: "WH-EVENT-0001",
    d: { at: 1, slot: "D" },
    s: [{ tid: "tid-1", attempt: "a-1", state: "responded", status: 200, receivedAt: 1, respondedAt: 2 }],
    listed: true,
    finding: { cls, flag: "OUT_OF_ORDER", final: true, why: "why text", waiting: "settling" },
    ring: { state: "ready", label: "ring label" },
    heal: { state: "sent", sends: 1 },
  });
  const base = scanOf([...many(3, TIED), { status: "GAP", cls: "ACKED_BUT_NOT_APPLIED" }, { status: "GAP", cls: "NO_REPORT", kind: "refunded" }, { status: "GAP", cls: "NO_EVENT_FOUND", kind: "completed", truth: "paid" }, UNV, { status: "UNVERIFIED", waiting: "requery_failed" }]);
  base.rows.forEach((r) => {
    r.book = { state: "paid", amount: "48.00", eid: "WH-BOOK-0001", at: 1 };
    r.refundStatus = "COMPLETED";
    if (r.status === "GAP") r.events = [f(r.events[0].finding!.cls, r.events[0].kind)];
  });
  // one tied row that PayPal's own retry closed: its tries, ids and book are strings and times too, and none of them may reach the certificate
  base.rows.push(rowOf(base.rows.length + 1, { status: "TIED", shape: "retry" }));
  base.summary.rows++;
  base.summary.tied++;
  base.summary.byClass = { ACKED_BUT_NOT_APPLIED: 1, NO_REPORT: 1, NO_EVENT_FOUND: 1 };
  base.reverify = { note: "reverify text" };
  return base;
}

test("A9: a marker string injected into any string of the scan, one place at a time and all at once, never reaches the certificate", () => {
  const scan = richScan();
  const baseline = certificateOf(scan);
  assert.equal(baseline.numbers.closedByPaypalRetry, 1, "the scan has one row PayPal's own retry closed, so its tries are among the places injected into");
  const paths = stringPaths(scan);
  assert.ok(paths.length > 80, `the scan has many string places to inject into (${paths.length})`);
  let reached = 0;
  for (const p of paths) {
    const injected = withLeaf(scan, p, MARKER);
    const cert = certificateOf(injected);
    if (JSON.stringify(cert).includes(MARKER)) reached++;
  }
  assert.equal(reached, 0, "0 of the injections reached the output");
  // All of them at once.
  let everything = structuredClone(scan);
  for (const p of paths) everything = withLeaf(everything, p, MARKER);
  assert.ok(!JSON.stringify(certificateOf(everything)).includes(MARKER));
  // Keys of byClass in the scan's summary are strings too: the certificate counts its own and ignores the summary's.
  const bad = structuredClone(scan);
  bad.summary.byClass = { [MARKER]: 9 };
  assert.deepEqual(certificateOf(bad), baseline, "the summary's class names are not used");
  // An unknown class on a finding is not shown.
  const odd = structuredClone(scan);
  odd.rows[3].events[0].finding!.cls = MARKER as never;
  assert.ok(!JSON.stringify(certificateOf(odd)).includes(MARKER));
  // An unknown status is never a verdict: the row is unverified, never tied.
  const unknown = structuredClone(scan);
  unknown.rows[0].status = MARKER as never;
  const c = certificateOf(unknown);
  assert.equal(c.numbers.tied, baseline.numbers.tied - 1);
  assert.equal(c.numbers.unverified, baseline.numbers.unverified + 1);
});

test("A9: the type cannot take a model's string: the context is numbers only, and the certificate has no input but the scan", () => {
  const scan = scanOf(many(2, TIED));
  // @ts-expect-error the context has no place for a sentence
  certificateOf(scan, { cause: "a model wrote this" });
  // @ts-expect-error a number, not a string
  certificateOf(scan, { rowsInsideListLag: "4" });
  assert.equal(certificateOf(scan, { rowsInsideListLag: Number.NaN }).limits.length, 0, "a number that is not a number is left out");
  assert.ok(!JSON.stringify(certificateOf(scan, { cause: "a model wrote this" } as never)).includes("a model wrote this"), "and a string passed past the type still goes nowhere");
});

// ---- A9: the forbidden words ----------------------------------------------------------------------------------------------------
const FORBIDDEN = ["complete", "nothing missing", "all tied", "every", "no gaps", "all clear", "fully"];
const hits = (text: string): string[] => FORBIDDEN.filter((w) => text.toLowerCase().includes(w));

test("A9: the forbidden words (complete, nothing missing, all tied, every, no gaps, all clear, fully) are in no template: the file is scanned whole, and each template is called over a range of numbers", () => {
  const source = readFileSync(join(HERE, "templates.ts"), "utf8");
  assert.deepEqual(hits(source), [], "templates.ts, comments included");
  const seen: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") seen.push(value);
    else if (typeof value === "function") for (const args of [[0, 0, 0, 0], [1, 1, 1, 1], [2, 41, 3, 5], [38, 41, 93, 0], [100, 100, 100, 100]]) seen.push(String((value as (...a: unknown[]) => unknown)(...args)));
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(templates);
  // Functions that take a string argument (an amount, a class phrase, seconds) are called with a plain one.
  seen.push(templates.header.money("96.00", 1, 0), templates.header.money("96.00", 0, 2), templates.header.money("96.00", 2, 3), templates.header.kinds("2 answered OK but the books do not match PayPal"), templates.header.found(2, 0, 3), templates.header.found(1, 1, 3), templates.owner.healed(2, "96.00"), templates.lateOverwritePhrase(2), templates.owner.refundsStillPaid(2, "96.00"), templates.owner.refundsNotShown(2, "96.00"), templates.owner.payments(1, "48.00"), templates.limits.deadline("10.0"));
  assert.ok(seen.length > 30, `many template outputs were produced (${seen.length})`);
  // The three sentences about rows PayPal's own retry closed take numbers only, were reached by that visit, and are in both grammatical forms.
  for (const part of ["booked on PayPal's own retry, after the shop did not take the earlier try", "booked on PayPal's own retry, after the shop did not take the earlier tries", "booked on PayPal's own retry, after the shop did not take the earlier try; this record does not show why", "booked on PayPal's own retry, after the shop did not take the earlier tries; this record does not show why", "your shop did not take PayPal's message at first"]) assert.ok(seen.some((x) => x.includes(part)), part);
  assert.deepEqual(seen.flatMap(hits), [], "every template output");
});

test("A9: over 500 random scans (and the 12 table cases) no field of the certificate holds a forbidden word", () => {
  const rand = prng(7);
  const found: string[] = [];
  const check = (scan: ScanResult, ctx = {}) => {
    const cert = certificateOf(scan, ctx);
    const text = [cert.stampText, cert.header, cert.footnote, ...cert.limits, ...cert.ownerView].join("\n");
    found.push(...hits(text));
  };
  for (const c of TABLE) check(scanOf(c.specs));
  for (let i = 0; i < 500; i++) check(randomScan(rand), { rowsInsideListLag: Math.floor(rand() * 5) });
  check(richScan(), { rowsInsideListLag: 3 });
  check(scanOf(many(3, TIED), { deadlineHit: true, listing: { asked: true, read: false, events: 0 } }));
  assert.deepEqual(found, []);
});

// ---- the owner's sentence follows what the books really say ----------------------------------------------------------------------------
const withBook = (spec: RowSpec, book: ScanRow["book"]): ScanRow => ({ ...rowOf(1, spec), book });
const scanOfRows = (rows: ScanRow[]): ScanResult => ({ ...scanOf([]), rows, summary: { rows: rows.length, tied: 0, gaps: rows.length, unverified: 0, byClass: {} } });
const PAID = { state: "paid" as const, amount: "48.00", eid: "WH-BOOK", at: 1 };

test("the owner view does not say 'still marked as paid' for a refund whose books have no entry (book = null): it says the books do not show the refund", () => {
  const cert = certificateOf(scanOfRows([withBook(GAP, null)]));
  assert.ok(cert.ownerView.includes("PayPal refunded 1 order; your books do not show the refund. That is $48.00."));
  assert.ok(!cert.ownerView.join("\n").includes("marked as paid"), "nothing about 'paid' when the books hold nothing");
  const paid = certificateOf(scanOfRows([withBook(GAP, PAID)]));
  assert.ok(paid.ownerView.includes("1 refund that PayPal made is still marked as paid in your books. That is $48.00."));
  assert.ok(!paid.ownerView.join("\n").includes("do not show the refund"));
  const refundedBook = certificateOf(scanOfRows([withBook(GAP, { ...PAID, state: "refunded" })]));
  assert.ok(refundedBook.ownerView.includes("PayPal refunded 1 order; your books do not show the refund. That is $48.00."), "an entry that does not say paid is not described as paid");
});

test("a mix is described row by row, with the money split between the two sentences and the sum unchanged", () => {
  const cert = certificateOf(scanOfRows([withBook({ ...GAP, amount: "48.00" }, PAID), withBook({ ...GAP, amount: "14.50" }, null), withBook({ ...GAP, amount: "48.00" }, PAID)]));
  assert.ok(cert.ownerView.includes("2 refunds that PayPal made are still marked as paid in your books. That is $96.00."));
  assert.ok(cert.ownerView.includes("PayPal refunded 1 order; your books do not show the refund. That is $14.50."));
  assert.equal(cert.numbers.moneyNotInBooks, "110.50");
  assert.equal(cert.numbers.refundsNotInBooks, 3);
});

// ---- found, healed, still open (A4) -------------------------------------------------------------------------------------------------------
// A row that a resend repaired is TIED and carries a heal record that says healed. The certificate counts those as found-and-healed.
const healedRow = (n: number, over: Partial<RowSpec> = {}): ScanRow => ({ ...rowOf(n, { status: "TIED", truth: "refunded", ...over }), events: [{ ...event("refunded", null), heal: { state: "healed", sends: 1, arrivalSeconds: 3.3, arrivedAt: 1_799_999_990_000 } }] });
const withRows = (rows: ScanRow[]): ScanResult => ({ ...scanOf([]), rows, summary: { rows: rows.length, tied: rows.filter((r) => r.status === "TIED").length, gaps: rows.filter((r) => r.status === "GAP").length, unverified: 0, byClass: {} } });

test("after a resend the header says what was found, what was healed and what is still open, with the real numbers", () => {
  const some = certificateOf(withRows([rowOf(1, TIED), healedRow(2), rowOf(3, GAP)]));
  assert.equal(some.numbers.healed, 1);
  assert.equal(some.numbers.gaps, 1);
  assert.equal(some.header, "2 gaps found · 1 healed · 1 still open (1 answered OK but the books do not match PayPal) · $48.00 across 1 refund not in books · checked 3 of 3 captures.");
  const all = certificateOf(withRows([rowOf(1, TIED), healedRow(2), healedRow(3)]));
  assert.equal(all.numbers.healed, 2);
  assert.equal(all.stamp, "green");
  assert.equal(all.header, "2 gaps found · 2 healed · 0 still open · checked 3 of 3 captures.");
  assert.ok(!all.header.includes("(100%)"), "the coverage is a secondary fact, not a score");
  // a tied row whose books never needed the resend is not a healed gap, and a heal record that is not "healed" is not one either
  const plain = certificateOf(withRows([rowOf(1, TIED), rowOf(2, TIED)]));
  assert.equal(plain.numbers.healed, 0);
  assert.equal(plain.header, "Checked 2 of 2 captures (100%).");
  const arrived = { ...rowOf(1, TIED), events: [{ ...event("refunded", null), heal: { state: "arrived" as const, sends: 1 } }] };
  assert.equal(certificateOf(withRows([arrived])).numbers.healed, 0);
});

// ---- booked on PayPal's own retry (lib/gaps/closure.ts) ---------------------------------------------------------------------------------------
const shaped = (...shapes: (Shape | null)[]): ScanResult => scanOf(shapes.map((shape) => ({ status: "TIED" as const, ...(shape ? { shape } : {}) })));

test("a tied row PayPal's own retry closed is counted, said in the header, the limits and the owner view, and is not a healed gap", () => {
  const cert = certificateOf(shaped("plain", "retry"));
  assert.equal(cert.numbers.closedByPaypalRetry, 1);
  assert.equal(cert.numbers.healed, 0);
  assert.equal(cert.stamp, "green", "the stamp does not change: it says whether the books match, not how they got there");
  assert.equal(cert.header, "Checked 2 of 2 captures (100%) · 1 booked on PayPal's own retry, after the shop did not take the earlier try.");
  assert.equal(cert.limits.at(-1), "1 capture was booked on PayPal's own retry, after the shop did not take the earlier try; this record does not show why, or whether the shop's code changed in between.");
  assert.deepEqual(cert.ownerView.slice(0, 3), ["We checked 2 of your 2 orders against PayPal's own records.", "Your books match PayPal on 2 of 2 orders.", "1 order: your shop did not take PayPal's message at first. PayPal tried again by itself, and your books took it then."]);
  assert.ok(!cert.header.includes("found") && !cert.header.includes("healed"), "no gap was found by us");
});

test("with two rows and three earlier tries the sentences are plural; the header's 'try' is singular only when the earlier tries total one", () => {
  const cert = certificateOf(shaped("retry", "retry_two"));
  assert.equal(cert.numbers.closedByPaypalRetry, 2);
  assert.equal(cert.header, "Checked 2 of 2 captures (100%) · 2 booked on PayPal's own retry, after the shop did not take the earlier tries.");
  assert.equal(cert.limits.at(-1), "2 captures were booked on PayPal's own retry, after the shop did not take the earlier tries; this record does not show why, or whether the shop's code changed in between.");
  // the limit counts the earlier tries the way the header does: "try" only when the total is 1
  assert.match(certificateOf(shaped("retry_two")).limits.at(-1)!, /^1 capture was booked on PayPal's own retry, after the shop did not take the earlier tries;/);
  assert.match(certificateOf(shaped("retry")).limits.at(-1)!, /^1 capture was booked on PayPal's own retry, after the shop did not take the earlier try;/);
  assert.ok(cert.ownerView.includes("2 orders: your shop did not take PayPal's message at first. PayPal tried again by itself, and your books took it then."));
  assert.match(certificateOf(shaped("retry_two")).header, /1 booked on PayPal's own retry, after the shop did not take the earlier tries\.$/, "one row, two earlier tries");
  assert.match(certificateOf(shaped("retry")).header, /after the shop did not take the earlier try\.$/, "one row, one earlier try");
});

test("with no such row there is no number, no header part, no limit and no owner line", () => {
  for (const cert of [certificateOf(shaped("plain", null)), certificateOf(shaped("new_tid", "in_flight", "healed_unarrived")), certificateOf(scanOf([]))]) {
    assert.ok(!("closedByPaypalRetry" in cert.numbers), "the key is not there at all");
    assert.ok(!/booked on PayPal's own retry/.test([cert.header, ...cert.limits, ...cert.ownerView].join("\n")));
    assert.ok(!cert.ownerView.some((l) => /tried again by itself/.test(l)));
  }
});

test("the closing line is the last of the limits, after the standing ones", () => {
  const cert = certificateOf(withRows([...shaped("retry").rows, rowOf(2, UNV)]), { rowsInsideListLag: 1 });
  assert.ok(cert.limits.length >= 3);
  assert.match(cert.limits.at(-1)!, /booked on PayPal's own retry/);
  assert.equal(cert.limits.filter((l) => /booked on PayPal's own retry/.test(l)).length, 1);
});

test("a delivery under a new transmission id is not PayPal's retry, so the certificate does not count it or say it", () => {
  const cert = certificateOf(shaped("new_tid"));
  assert.equal(cert.numbers.closedByPaypalRetry, undefined);
  assert.equal(cert.header, "Checked 1 of 1 capture (100%).");
  assert.deepEqual(cert.limits, []);
});

test("a try still in flight leaves the row uncounted: undecided is not a closure", () => {
  assert.equal(certificateOf(shaped("in_flight")).numbers.closedByPaypalRetry, undefined);
});

test("a row is healed only when the heal record says healed AND the resend arrived; a healed record without the arrival is not counted as healed", () => {
  const without = certificateOf(shaped("healed_unarrived"));
  assert.equal(without.numbers.healed, 0);
  assert.equal(without.header, "Checked 1 of 1 capture (100%).", "no 'gap found, healed' lead for a resend nobody saw arrive");
  assert.ok(!without.ownerView.some((l) => /did not match PayPal earlier/.test(l)));
  // arrivalSeconds alone is a derived number, not the arrival
  const onlySeconds = { ...rowOf(1, TIED), events: [{ ...event("refunded", null), heal: { state: "healed" as const, sends: 1, arrivalSeconds: 3.3 } }] };
  assert.equal(certificateOf(withRows([onlySeconds])).numbers.healed, 0);
  // and with the arrival it is counted
  const withArrival = certificateOf(shaped("healed_arrived"));
  assert.equal(withArrival.numbers.healed, 1);
  assert.equal(withArrival.header, "1 gap found · 1 healed · 0 still open · checked 1 of 1 capture.");
  assert.equal(withArrival.numbers.closedByPaypalRetry, undefined, "a row our resend repaired is not also said to have been closed by PayPal's retry");
});

test("healed and booked-on-PayPal's-retry are disjoint: a healed record without the arrival lets PayPal's retry be told, one with it does not", () => {
  const cert = certificateOf(shaped("healed_arrived", "healed_unarrived_retry", "retry", "plain"));
  assert.equal(cert.numbers.healed, 1);
  assert.equal(cert.numbers.closedByPaypalRetry, 2);
  assert.equal(cert.numbers.tied, 4);
  assert.ok(cert.numbers.healed + (cert.numbers.closedByPaypalRetry ?? 0) <= cert.numbers.tied);
  assert.equal(cert.header, "1 gap found · 1 healed · 0 still open · checked 4 of 4 captures · 2 booked on PayPal's own retry, after the shop did not take the earlier tries.");
  assert.ok(cert.ownerView.includes("1 order did not match PayPal earlier ($48.00). PayPal was asked to send its message again, and your books now match."));
  assert.ok(cert.ownerView.includes("2 orders: your shop did not take PayPal's message at first. PayPal tried again by itself, and your books took it then."));
});

test("the owner view puts the near miss after what is wrong or what matches, and before the unchecked lines", () => {
  const closure = "1 order: your shop did not take PayPal's message at first. PayPal tried again by itself, and your books took it then.";
  const red = certificateOf(withRows([...shaped("retry").rows, withBook(GAP, PAID)])).ownerView;
  assert.deepEqual(red.slice(0, 4), ["We checked 2 of your 2 orders against PayPal's own records.", "1 refund that PayPal made is still marked as paid in your books. That is $48.00.", "These need your attention: your books and PayPal disagree.", closure]);
  const green = certificateOf(shaped("retry", "plain")).ownerView;
  assert.deepEqual(green.slice(0, 3), ["We checked 2 of your 2 orders against PayPal's own records.", "Your books match PayPal on 2 of 2 orders.", closure]);
  const healed = certificateOf(shaped("retry", "healed_arrived")).ownerView;
  assert.deepEqual(healed.map((l) => l.slice(0, 12)), ["We checked 2", "1 order did ", "Your books m", "1 order: you", "We can only ", "This page is"], "after the healed line and the match line");
  const unchecked = certificateOf(withRows([...shaped("retry").rows, rowOf(2, UNV)])).ownerView;
  assert.equal(unchecked.indexOf(closure) + 1, unchecked.findIndex((l) => /too new to check/.test(l)), "directly before the line about the orders not checked yet");
});

test("a gap still open next to a row PayPal's retry closed: both are said, and the stamp stays red", () => {
  const cert = certificateOf(withRows([...shaped("retry").rows, rowOf(2, GAP)]));
  assert.equal(cert.stamp, "red");
  assert.equal(cert.numbers.closedByPaypalRetry, 1);
  assert.match(cert.header, /1 of 2 captures did not match PayPal .*· checked 2 of 2 captures · 1 booked on PayPal's own retry, after the shop did not take the earlier try\.$/);
});

test("a row that is not tied is never counted, whatever its tries show", () => {
  const rows = ["GAP", "UNVERIFIED"].map((status, i): ScanRow => ({ ...rowOf(i + 1, { status: "TIED", shape: "retry" }), status: status as RowStatus, ...(status === "UNVERIFIED" ? { waiting: "settling" as const } : {}) }));
  assert.equal(certificateOf(withRows(rows)).numbers.closedByPaypalRetry, undefined);
});

test("500 random scans: the counts are the shapes' own, the key is there only above 0, and the sentences follow the counts", () => {
  const rand = prng(20261021);
  let withClosed = 0;
  let withHealed = 0;
  for (let i = 0; i < 500; i++) {
    const { scan, shapes } = randomScanShaped(rand, true);
    const cert = certificateOf(scan);
    const kinds = shapes.filter((s): s is Shape => s !== null);
    const closed = kinds.filter((s) => SHAPES[s].earlier > 0 && !SHAPES[s].healed).length;
    const earlier = kinds.reduce((sum, s) => sum + (SHAPES[s].healed ? 0 : SHAPES[s].earlier), 0);
    const healed = kinds.filter((s) => SHAPES[s].healed).length;
    const n = cert.numbers;
    assert.equal(n.closedByPaypalRetry ?? 0, closed, `scan ${i}: closed`);
    assert.equal("closedByPaypalRetry" in n, closed > 0, `scan ${i}: the key is there only above 0`);
    assert.equal(n.healed, healed, `scan ${i}: healed`);
    assert.ok(n.healed + (n.closedByPaypalRetry ?? 0) <= n.tied, `scan ${i}: disjoint`);
    const said = (text: string) => [cert.header, ...cert.limits, ...cert.ownerView].some((l) => l.includes(text));
    assert.equal(said("booked on PayPal's own retry, after the shop did not take the earlier"), closed > 0, `scan ${i}: header and limits`);
    assert.equal(cert.header.includes(`${closed} booked on PayPal's own retry, after the shop did not take the earlier ${closed === 1 && earlier === 1 ? "try" : "tries"}`), closed > 0, `scan ${i}: header grammar`);
    assert.equal(cert.limits.filter((l) => l.includes("booked on PayPal's own retry")).length, closed > 0 ? 1 : 0, `scan ${i}: one limit`);
    assert.equal(cert.limits.some((l) => l.includes(`after the shop did not take the earlier ${closed === 1 && earlier === 1 ? "try" : "tries"};`)), closed > 0, `scan ${i}: limit grammar is the header's`);
    assert.equal(cert.ownerView.some((l) => l.includes("tried again by itself")), closed > 0, `scan ${i}: owner view`);
    assert.equal(cert.ownerView.some((l) => l.includes("did not match PayPal earlier")), healed > 0, `scan ${i}: healed line`);
    if (closed > 0) withClosed++;
    if (healed > 0) withHealed++;
  }
  assert.ok(withClosed > 100 && withHealed > 100, `the random scans reach both cases (${withClosed} with a closed row, ${withHealed} with a healed one)`);
});

test("a late payment that overwrote a refund is not described as 'answered 200 but not applied': its books did change", () => {
  const late = (n: number): ScanRow => ({ ...rowOf(n, GAP), events: [event("refunded", finding("ACKED_BUT_NOT_APPLIED", { flag: "OUT_OF_ORDER" }))] });
  const cert = certificateOf(withRows([late(1), late(2)]));
  assert.equal(cert.header, "2 of 2 captures did not match PayPal (2 overwritten by a late payment) · $96.00 across 2 refunds not in books · checked 2 of 2 captures.");
  assert.ok(!/not applied/.test(cert.header));
  // mixed with a plain ack: both phrases, each with its own count
  const mix = certificateOf(withRows([late(1), rowOf(2, GAP)]));
  assert.match(mix.header, /\(1 answered OK but the books do not match PayPal, 1 overwritten by a late payment\)/);
  // the class count in the numbers still counts the class (unchanged)
  assert.equal(mix.numbers.byClass.ACKED_BUT_NOT_APPLIED, 2);
});

test("the owner view says in one line what was wrong once a resend has repaired it, and keeps saying what is still wrong", () => {
  const healed = certificateOf(withRows([rowOf(1, TIED), healedRow(2), healedRow(3)]));
  assert.deepEqual(healed.ownerView.slice(0, 3), ["We checked 3 of your 3 orders against PayPal's own records.", "2 orders did not match PayPal earlier ($96.00). PayPal was asked to send their messages again, and your books now match.", "Your books match PayPal on 3 of 3 orders."]);
  const part = certificateOf(withRows([rowOf(1, TIED), healedRow(2), withBook(GAP, PAID)]));
  assert.ok(part.ownerView.includes("1 order did not match PayPal earlier ($48.00). PayPal was asked to send its message again, and your books now match."));
  assert.ok(part.ownerView.includes("1 refund that PayPal made is still marked as paid in your books. That is $48.00."));
  assert.ok(!part.ownerView.some((l) => /^Your books match PayPal on/.test(l)), "no 'books match' while a gap is open");
  // nothing healed, nothing said about it
  assert.ok(!certificateOf(scanOf(many(2, TIED))).ownerView.some((l) => /earlier/.test(l)));
});

// ---- exact strings ---------------------------------------------------------------------------------------------------------------------
test("the empty-session header is exactly one sentence with one full stop (it had two)", () => {
  const cert = certificateOf(scanOf([]));
  assert.equal(cert.header, "Nothing checked yet: this session has no orders.");
  assert.equal(cert.stampText, "Nothing checked yet");
  assert.ok(!cert.header.includes(".."));
  // and no header of the others ends in two
  for (const c of TABLE) assert.ok(!certificateOf(scanOf(c.specs)).header.includes(".."), c.name);
});

test("each reason a row can be unverified has its own line in the limits, and no line says what is not the reason", () => {
  const one = (waiting: Waiting | undefined) => certificateOf(scanOf([{ status: "UNVERIFIED", waiting }]));
  assert.deepEqual(one("status_not_modeled").limits, ["1 row shows a PayPal state that the shop has no entry for, so it is not compared."]);
  assert.deepEqual(one("listing_unavailable").limits, ["1 row could not be judged because PayPal's event list could not be read."]);
  assert.deepEqual(one("reporter_record_missing").limits, ["1 row: the shop noted the event arriving, but its reporter has no record of what it answered, so the result is unknown."]);
  assert.deepEqual(one(undefined).limits, ["1 row could not be confirmed."]);
  // none of the other three reasons is described with a state the shop does not book
  for (const w of ["listing_unavailable", "reporter_record_missing"] as const) assert.ok(!/no entry for|does not book|do not book/.test(one(w).limits.join(" ")), w);
  // together: one line each, counted, and the header still has one number for them
  const all = certificateOf(scanOf([...many(2, { status: "UNVERIFIED", waiting: "status_not_modeled" }), { status: "UNVERIFIED", waiting: "listing_unavailable" }, { status: "UNVERIFIED", waiting: "reporter_record_missing" }, { status: "UNVERIFIED", waiting: undefined }]));
  assert.equal(all.limits.length, 4);
  assert.match(all.header, /5 unverified for another reason/);
  assert.equal(all.numbers.unverified, 5);
});
