// The fifth recorded run, "dispute_never_heard" (scripts/record-run.ts --only dispute_never_heard). The checks below are written once and run twice:
// on a synthetic run made from the gap finder's stand-ins (so that the checks themselves are tested now), and on fixtures/recorded-run/dispute_never_heard.json
// as soon as that file exists (until then that test is skipped, and says why).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../cause/test-helpers.ts";
import type { RecordedReplays } from "../cause/replay.ts";
import { certificateOf, rowsInsideListLag } from "../cert/cert.ts";
import { gapWorld } from "../gaps/test-world.ts";
import { computeDiffs } from "../shop/diffs.ts";
import { checkSnapshot } from "../ui/check.ts";
import { heartbeatOfScan } from "../witness/heartbeat.ts";
import { buildLiveSnapshot } from "./build.ts";
import { checkDisputeScenario } from "./check-disputes.ts";
import type { RecordedDisputeScenario, RunSnapshot } from "./snapshot.ts";
import { disputeTitle, type DisputeStep } from "./titles.ts";

const FILE = join(ROOT, "fixtures/recorded-run/dispute_never_heard.json");
const STEPS: DisputeStep[] = ["before", "listed", "due", "ring"];
const FORBIDDEN = ["complete", "nothing missing", "all tied", "every", "no gaps", "all clear", "fully"];
const hits = (text: string): string[] => FORBIDDEN.filter((w) => new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`, "i").test(text));
const SECRET_LOOKING = /(sk-ant-|Bearer |client_secret|PAYPAL_|DOORBELL_LIVE|KV_REST|x-live-token|BEGIN [A-Z ]*PRIVATE)/i;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) (out.push(k), strings(v, out));
  return out;
}

function assertScenario(sc: RecordedDisputeScenario, raw: string, o: { realDates: boolean }): void {
  assert.equal(sc.id, "dispute_never_heard");
  assert.equal(sc.plantedMode, "none");
  assert.equal(sc.steps.length, 4);
  assert.deepEqual(checkDisputeScenario(sc), [], "the dispute rules");
  const target = sc.steps.at(-1)!.scan!.rows.find((r) => r.disputes?.length)!.captureId;
  sc.steps.forEach((st, i) => {
    const where = `step ${i + 1}`;
    assert.deepEqual([st.mode, st.step?.index, st.step?.of], ["RECORDED RUN", i + 1, 4], where);
    assert.equal(st.session.session.mode, "good", `${where}: no handler is broken`);
    assert.equal(st.session.session.planted, false);
    assert.deepEqual(st.causes, [], `${where}: a dispute has no code to blame`);
    if (i > 0) assert.ok(st.recordedAt! >= sc.steps[i - 1].recordedAt!, "time order");
    if (o.realDates) assert.ok(typeof st.recordedAt === "number" && st.recordedAt > Date.parse("2026-10-20T00:00:00Z") && st.recordedAt < Date.now() + 1000, `${where}: a real date`);
    assert.equal(st.step!.title, disputeTitle(STEPS[i], st, target), `${where}: the title is what titles.ts says about its snapshot`);
    assert.deepEqual(st.certificate, certificateOf(st.scan!, { rowsInsideListLag: rowsInsideListLag(st.session.orders, st.scan!.at) }), `${where}: the certificate is certificateOf(scan) (scripts/record-run.ts --rebuild recomputes it)`);
    assert.deepEqual(st.heartbeat, heartbeatOfScan(st.scan!, st.session), `${where}: the heartbeat`);
    assert.deepEqual(checkSnapshot(st).filter((v) => !/ is a gap without a final finding$/.test(v)), [], `${where}: the rules every snapshot obeys`);
    assert.equal(st.scan!.disputeReads?.unreadable, 0, `${where}: PayPal's dispute list was read for every order`);
  });
  const [before, listed, due, ring] = sc.steps;
  assert.deepEqual([before.scan!.summary.tied, before.scan!.summary.gaps, before.certificate!.stamp], [3, 0, "green"], "step 1: three orders tied");
  for (const [i, st] of [listed, due, ring].entries()) {
    const row = st.scan!.rows.find((r) => r.captureId === target)!;
    const d = row.disputes![0];
    assert.deepEqual([row.status, st.scan!.summary.gaps, st.scan!.summary.tied, st.certificate!.stamp], ["GAP", 1, 2, "red"], `step ${i + 2}`);
    assert.deepEqual([d.status, d.finding?.cls, d.finding?.flag, d.finding?.final, d.webhooks, d.ring?.state], ["GAP", "NO_REPORT", "UNSUBSCRIBED_EVENT_TYPE", true, { shop: false, any: false }, "cannot_heal"], `step ${i + 2}: the dispute`);
    assert.equal(st.certificate!.numbers.disputes?.notInBooks, 1);
    assert.equal(st.certificate!.numbers.disputes?.moneyNotInBooks, d.amount);
    assert.ok(st.certificate!.limits.some((l) => /no webhook of this app subscribes to dispute events/.test(l)), "the cannot-prove line");
    assert.ok(st.certificate!.limits.some((l) => /response-due date/.test(l)), "where the due date comes from");
  }
  const dueRow = due.scan!.rows.find((r) => r.captureId === target)!;
  assert.deepEqual([dueRow.disputes![0].dueDateSource, typeof dueRow.disputes![0].sellerResponseDueAt], ["sandbox_test", "number"], "step 3 has the response-due date, labelled as the test call's");
  assert.equal(due.scan!.rows.find((r) => r.captureId === target)!.events.every((e) => e.finding === null), true, "the capture's own payment is not blamed: PENDING is explained by the dispute");
  assert.equal(ring.scan!.resendsUsed, 0, "Ring again sent nothing");
  // honesty
  const all = strings(sc);
  assert.deepEqual(all.flatMap(hits), [], "no forbidden word anywhere in the file");
  assert.ok(!SECRET_LOOKING.test(raw), "no credential");
  for (const st of sc.steps) assert.match(st.session.session.id, /^[0-9a-f]{32}$/);
  assert.equal(new Set(sc.steps.map((x: RunSnapshot) => x.session.session.id)).size, 1, "one session throughout");
  for (const id of sc.paypalIds) assert.ok(JSON.stringify(sc.steps).includes(id), id);
  const disputeId = ring.scan!.rows.find((r) => r.captureId === target)!.disputes![0].disputeId;
  assert.ok(sc.paypalIds.includes(disputeId) && sc.paypalIds.includes(target), "the dispute id and the capture id can be looked up in the Sandbox dashboard");
}

// A run made from the stand-ins, in the shape the recording script writes.
async function synthetic(): Promise<{ sc: RecordedDisputeScenario; raw: string }> {
  const w = gapWorld();
  const sid = await w.session();
  const orders = [await w.order(sid, { book: "paid" }), await w.order(sid, { book: "paid" }), await w.order(sid, { book: "paid" })];
  const target = orders[1].captureId;
  const deps = { scan: w.deps({ disputes: { reads: w.disputeReads } }), bundle: computeDiffs(ROOT), recordedReplays: JSON.parse(readFileSync(join(ROOT, "fixtures/replay/recorded.json"), "utf8")) as RecordedReplays, log: () => undefined };
  const shots: RunSnapshot[] = [];
  const take = async () => shots.push(await buildLiveSnapshot(deps, sid, (await w.store.getSession(sid))!));
  await take();
  w.clock.now += 90_000;
  w.dispute(target, { ageMs: 50_000, status: "OPEN" });
  await take();
  w.clock.now += 130_000;
  w.paypal.disputes.set(target, [{ ...w.paypal.disputes.get(target)![0], status: "WAITING_FOR_SELLER_RESPONSE", sellerResponseDueAt: Date.parse("2026-10-31T03:59:59.000Z") }]);
  w.paypal.captures.set(target, "PENDING");
  await take();
  await take();
  const steps = shots.map((s, i): RunSnapshot => ({ ...s, mode: "RECORDED RUN", recordedAt: 1_800_000_000_000 + i * 60_000, step: { index: i + 1, of: 4, title: disputeTitle(STEPS[i], s, target) } }));
  const paypalIds = [...new Set(steps.flatMap((s) => [...s.session.orders.flatMap((o) => [o.orderId, o.captureId]), ...s.scan!.rows.flatMap((r) => (r.disputes ?? []).map((d) => d.disputeId))]))].sort();
  const fake = createHash("sha256").update(`recorded:${sid}`).digest("hex").slice(0, 32); // what scripts/record-run.ts does to the session id
  const raw = JSON.stringify({ id: "dispute_never_heard", title: "t", plantedMode: "none", capturedAt: steps[0].recordedAt!, steps, paypalIds }).split(sid).join(fake);
  return { sc: JSON.parse(raw) as RecordedDisputeScenario, raw };
}

test("the checks for the dispute run hold on a run made from the stand-ins", async () => {
  const { sc, raw } = await synthetic();
  assertScenario(sc, raw, { realDates: false });
});

test("the checks refuse what they are meant to refuse: a forbidden word, a changed title, a stale certificate, a resend", async () => {
  const { sc, raw } = await synthetic();
  const clone = () => structuredClone(sc);
  const bad = (mutate: (s: RecordedDisputeScenario) => void) => {
    const s = clone();
    mutate(s);
    return () => assertScenario(s, JSON.stringify(s), { realDates: false });
  };
  assert.throws(bad((s) => (s.steps[1].step!.title += " Every dispute is shown.")));
  assert.throws(bad((s) => (s.steps[0].step!.title = "x")));
  assert.throws(bad((s) => (s.steps[2].certificate!.header += " ")));
  assert.throws(bad((s) => (s.steps[3].scan!.resendsUsed = 1)));
  assert.throws(bad((s) => (s.steps[3].session.session.mode = "ack_then_drop")));
  assert.throws(() => assertScenario(sc, `${raw} Bearer abc`, { realDates: false }));
});

test("fixtures/recorded-run/dispute_never_heard.json, once recorded, passes the same checks", { skip: existsSync(FILE) ? false : "fixtures/recorded-run/dispute_never_heard.json has not been recorded yet (npx tsx scripts/record-run.ts --only dispute_never_heard)" }, () => {
  const raw = readFileSync(FILE, "utf8");
  assertScenario(JSON.parse(raw) as RecordedDisputeScenario, raw, { realDates: true });
});
