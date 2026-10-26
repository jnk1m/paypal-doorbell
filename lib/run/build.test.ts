// The live snapshot (S5): the scan, the certificate and the heartbeat from one ScanResult; causes from the recorded model answers; the replay
// live while the deliveries are young, the recorded one after that, nothing when there is neither. Everything here is offline: the shop's
// store and PayPal are the stand-ins of the gap finder's tests, the model is never reached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose } from "../cause/cause.ts";
import { answering, openGate, ROOT } from "../cause/test-helpers.ts";
import { REPLAY_WINDOW_MS, type RecordedReplays } from "../cause/replay.ts";
import { certificateOf } from "../cert/cert.ts";
import { gapWorld } from "../gaps/test-world.ts";
import { computeDiffs } from "../shop/diffs.ts";
import { COMPLETED, REFUNDED } from "../shop/events.ts";
import { completedEvent, fakePaypal, refundedEvent, SHOP_WEBHOOK_ID } from "../shop/test-helpers.ts";
import type { BrokenMode, PlantedMode } from "../shop/types.ts";
import { checkSnapshot } from "../ui/check.ts";
import { heartbeatOfScan } from "../witness/heartbeat.ts";
import type { AttemptEntry } from "../witness/store.ts";
import { buildLiveSnapshot, type SnapshotDeps } from "./build.ts";
import { createCoalescer } from "./coalesce.ts";
import { deployInput } from "./deploy-input.ts";
import type { RunSnapshot } from "./snapshot.ts";

const BUNDLE = computeDiffs(ROOT);
const RECORDED = JSON.parse(readFileSync(join(ROOT, "fixtures/replay/recorded.json"), "utf8")) as RecordedReplays;

// A session whose shop answered the refund the way the planted mode does, with both events heard by the witness (signed, stored).
async function plantedWorld(mode: BrokenMode, o: { rows?: number; heardBoth?: boolean; hearRefundOnly?: boolean; delayMs?: number } = {}) {
  const w = gapWorld({ delayMs: o.delayMs });
  const pp = fakePaypal();
  const sid = await w.session(mode);
  const stored = new Map<string, AttemptEntry>();
  const refundTids: string[] = [];
  const store = (d: ReturnType<typeof pp.sign>, type: string, eid: string): void => {
    stored.set(d.tid, { v: 1, tid: d.tid, slot: "D", at: Date.now(), st: "ok", h: { time: d.headers["paypal-transmission-time"], sig: d.headers["paypal-transmission-sig"], algo: d.headers["paypal-auth-algo"], cert: d.headers["paypal-cert-url"] }, eid, type, raw: d.raw, sha: "x", len: d.raw.length });
  };
  for (let i = 0; i < (o.rows ?? 2); i++) {
    const row = await w.order(sid, { refund: true, book: "paid", eventsListed: true });
    const paid = pp.sign(completedEvent(row.captureId, "48.00", row.paidEid));
    const refunded = pp.sign(refundedEvent(row.captureId, row.refundId, "48.00", row.refundEid));
    store(paid, COMPLETED, row.paidEid);
    store(refunded, REFUNDED, row.refundEid);
    refundTids.push(refunded.tid);
    if (o.heardBoth !== false) {
      if (!o.hearRefundOnly) await w.heard({ eid: row.paidEid, tid: paid.tid, type: COMPLETED, resourceId: row.captureId, at: row.at + 2_000 });
      await w.heard({ eid: row.refundEid, tid: refunded.tid, type: REFUNDED, resourceId: row.refundId, at: row.at + 12_000 });
    }
    // The shop's side of it: the payment was booked; the refund reached the handler and was answered as the planted mode answers.
    await w.deliver({ eid: row.paidEid, tid: paid.tid, type: COMPLETED, resourceId: row.captureId, status: 200, at: row.at + 2_000 });
    const answers = mode === "bad_body" || mode === "wrong_webhook_id_setting" ? [401, 401, 401] : [200];
    for (const [k, status] of answers.entries()) await w.deliver({ eid: row.refundEid, tid: refunded.tid, type: REFUNDED, resourceId: row.refundId, status, at: row.at + 12_000 + k * 30_000 });
  }
  w.clock.now += 10 * 60_000; // nothing is "settling" and no absence window is open
  return { w, pp, sid, stored };
}

function depsOf(w: Awaited<ReturnType<typeof plantedWorld>>, over: Partial<SnapshotDeps> = {}, counters = { verify: 0, loads: 0 }) {
  const deps: SnapshotDeps = {
    scan: w.w.deps(),
    bundle: BUNDLE,
    recordedReplays: RECORDED,
    replay: {
      witness: () => ({ attempts: async (tid: string) => (counters.loads++, w.stored.has(tid) ? [w.stored.get(tid)!] : []) }),
      webhookIdOf: () => SHOP_WEBHOOK_ID,
      verify: async (p) => (counters.verify++, w.pp.verify(p)),
      cache: new Map(),
      inflight: new Map(),
    },
    log: () => undefined,
    ...over,
  };
  return { deps, counters };
}

const sessionOf = async (w: Awaited<ReturnType<typeof plantedWorld>>) => (await w.w.store.getSession(w.sid))!;

test("a planted session: the snapshot is LIVE, holds the scan, a certificate and a heartbeat computed from that same scan, and one cause per gap row", async () => {
  const world = await plantedWorld("ack_then_drop");
  const { deps } = depsOf(world);
  const snap = await buildLiveSnapshot(deps, world.sid, await sessionOf(world));
  assert.equal(snap.mode, "LIVE");
  assert.equal(snap.recordedAt, null);
  assert.equal(snap.step, null);
  assert.equal(snap.scan!.summary.gaps, 2);
  assert.equal(snap.session.session.id, world.sid);
  assert.equal(snap.session.session.mode, "ack_then_drop");
  // computed from the scan, nothing else
  assert.deepEqual(snap.certificate, certificateOf(snap.scan!, { rowsInsideListLag: 0 }));
  assert.equal(snap.certificate!.stamp, "red");
  assert.equal(snap.certificate!.numbers.gaps, 2);
  assert.equal(snap.certificate!.numbers.moneyNotInBooks, "96.00");
  assert.deepEqual(snap.heartbeat, heartbeatOfScan(snap.scan!, snap.session));
  assert.equal(snap.scan!.listing.read, true, "the snapshot asks for PayPal's list even though nothing else needed it");
  // one cause per gap row, the recorded one, for the session's own mode
  assert.equal(snap.causes.length, 2);
  assert.deepEqual(snap.causes.map((c) => c.captureId).sort(), snap.scan!.rows.map((r) => r.captureId).sort());
  for (const c of snap.causes) {
    assert.equal(c.mode, "ack_then_drop");
    assert.equal(c.cause.status, "proposed");
    assert.equal(c.cause.status === "proposed" && c.cause.category, "WORK_AFTER_ACK");
    assert.equal(c.cause.status === "proposed" && c.cause.source, "recording", "no live model call: the answer is the recording");
    assert.equal(c.replay?.mode, "ack_then_drop");
    assert.equal(c.confirmation?.confirmed, true);
    assert.equal(c.confirmation?.chip, "CONFIRMED BY REPLAY");
  }
});

test("the replay is live while the deliveries are young: 2 x N verify calls (N = 2: 4), once per session and mode, not once per poll or per row", async () => {
  const world = await plantedWorld("ack_then_drop", { rows: 3 });
  const { deps, counters } = depsOf(world);
  const first = await buildLiveSnapshot(deps, world.sid, await sessionOf(world));
  assert.equal(first.causes.length, 3);
  assert.equal(first.causes[0].replay?.basis, "replayed");
  assert.equal(first.causes[0].replay?.verdict, "CONFIRMED BY REPLAY");
  assert.equal(counters.verify, 4, "one replay of two deliveries through two builds, for three gap rows");
  assert.equal(first.causes[1].replay, first.causes[0].replay, "the other rows of the mode show the same result");
  const second = await buildLiveSnapshot(deps, world.sid, await sessionOf(world));
  assert.equal(counters.verify, 4, "the next poll is served from the kept result");
  assert.deepEqual(second.causes[0].replay, first.causes[0].replay);
});

test("the limiter for replays: when it says no, the recorded result is shown, labelled recorded, and PayPal is not asked", async () => {
  const world = await plantedWorld("ack_then_drop");
  const { deps, counters } = depsOf(world);
  const snap = await buildLiveSnapshot(deps, world.sid, await sessionOf(world), { allowReplay: async () => false });
  assert.equal(counters.verify, 0);
  assert.equal(snap.causes[0].replay?.basis, "recorded");
  assert.equal(snap.causes[0].replay?.verdict, "CONFIRMED BY REPLAY");
  assert.equal(snap.causes[0].confirmation?.chip, "CONFIRMED BY REPLAY · recorded");
  // and when it says yes it is asked once per live replay, not per row or per poll
  let asked = 0;
  await buildLiveSnapshot(deps, world.sid, await sessionOf(world), { allowReplay: async () => (asked++, true) });
  await buildLiveSnapshot(deps, world.sid, await sessionOf(world), { allowReplay: async () => (asked++, true) });
  assert.equal(asked, 1);
});

test("deliveries older than the replay window: the recorded result, no verify call; with no recorded result for the mode, nothing is shown", async () => {
  const world = await plantedWorld("ack_then_drop");
  const { deps, counters } = depsOf(world, { now: () => Date.now() + REPLAY_WINDOW_MS + 3_600_000 });
  const old = await buildLiveSnapshot(deps, world.sid, await sessionOf(world));
  assert.equal(counters.verify, 0);
  assert.equal(old.causes[0].replay?.basis, "recorded");
  const { deps: bare } = depsOf(world, { now: () => Date.now() + REPLAY_WINDOW_MS + 3_600_000, recordedReplays: {} });
  const none = await buildLiveSnapshot(bare, world.sid, await sessionOf(world));
  assert.equal(none.causes[0].replay?.basis, "none", "nothing was recorded either: NOT CONFIRMED, said as such");
  assert.equal(none.causes[0].confirmation?.confirmed, false);
});

test("a cause is never paired with another mode's replay: the only recorded replay is another mode's, and it is not shown", async () => {
  const world = await plantedWorld("ack_then_drop", { heardBoth: false });
  const { deps } = depsOf(world, { recordedReplays: { bad_body: RECORDED.bad_body, last_write_wins: RECORDED.last_write_wins } });
  const snap = await buildLiveSnapshot(deps, world.sid, await sessionOf(world));
  assert.ok(snap.causes.length > 0);
  for (const c of snap.causes) {
    assert.equal(c.replay, null, "the witness heard nothing to replay and ack_then_drop has no recorded result: nothing, not another mode's");
    assert.equal(c.confirmation?.confirmed, false);
    assert.match(c.confirmation?.note ?? "", /No replay result/);
  }
  for (const mode of ["ack_then_drop", "bad_body", "last_write_wins"] as PlantedMode[]) {
    const w = await plantedWorld(mode);
    const s = await buildLiveSnapshot(depsOf(w).deps, w.sid, await sessionOf(w));
    for (const c of s.causes) {
      assert.equal(c.mode, mode);
      assert.equal(c.replay?.mode, mode);
    }
  }
});

test("each planted mode: its own cause, its own replay, CONFIRMED BY REPLAY (3 modes)", async () => {
  const expected: Record<PlantedMode, string> = { ack_then_drop: "WORK_AFTER_ACK", bad_body: "RAW_BODY_ALTERED", last_write_wins: "OTHER_CODE_CHANGE" };
  for (const mode of Object.keys(expected) as PlantedMode[]) {
    const world = await plantedWorld(mode);
    const snap = await buildLiveSnapshot(depsOf(world).deps, world.sid, await sessionOf(world));
    const c = snap.causes[0];
    assert.ok(c, `${mode}: a cause`);
    assert.equal(c.cause.status === "proposed" && c.cause.category, expected[mode], mode);
    assert.equal(c.replay?.verdict, "CONFIRMED BY REPLAY", mode);
    assert.equal(c.confirmation?.confirmed, true, mode);
  }
});

test("the good handler has no diff and no cause: a session that was fixed shows its gaps and no cause card", async () => {
  const world = await plantedWorld("ack_then_drop");
  await world.w.store.setMode(world.sid, "good");
  const snap = await buildLiveSnapshot(depsOf(world).deps, world.sid, await sessionOf(world));
  assert.equal(snap.scan!.summary.gaps, 2);
  assert.deepEqual(snap.causes, []);
});

test("a recording that is missing (the prompt or a handler changed) is 'not diagnosed', never a live model call and never a guess", async () => {
  const world = await plantedWorld("ack_then_drop");
  const snap = await buildLiveSnapshot(depsOf(world, { causeDir: join(ROOT, "lib/run") }).deps, world.sid, await sessionOf(world));
  for (const c of snap.causes) {
    assert.equal(c.cause.status, "not_diagnosed");
    assert.equal(c.cause.status === "not_diagnosed" && c.cause.reason, "no_recording");
    assert.equal(c.confirmation, null, "no cause, nothing to confirm");
  }
});

test("a replay that cannot load its deliveries (expired from the witness store) falls back to the recorded result", async () => {
  const world = await plantedWorld("ack_then_drop");
  world.stored.clear();
  const { deps } = depsOf(world);
  const snap = await buildLiveSnapshot(deps, world.sid, await sessionOf(world));
  assert.equal(snap.causes[0].replay?.basis, "recorded");
});

test("a session with every row agreeing has a green certificate, no cause, and a heartbeat that says what it could compare", async () => {
  const w = gapWorld();
  const sid = await w.session("ack_then_drop");
  const o = await w.order(sid, { book: "paid", eventsListed: true });
  await w.heard({ eid: o.paidEid, tid: "tid-1", type: COMPLETED, resourceId: o.captureId, at: o.at + 5_000 });
  w.clock.now += 10 * 60_000;
  const world = { w, pp: fakePaypal(), sid, stored: new Map<string, AttemptEntry>() };
  const snap = await buildLiveSnapshot(depsOf(world).deps, sid, (await w.store.getSession(sid))!);
  assert.equal(snap.certificate!.stamp, "green");
  assert.equal(snap.certificate!.stampText, "Tied on 1/1 of what we can see");
  assert.deepEqual(snap.causes, []);
  assert.equal(snap.heartbeat!.listedMissedByWitness, 0);
  assert.equal(snap.scan!.listing.read, true);
});

// ---- a cause that is not proven has no replay and no confirmation --------------------------------------------------------------------------

// A cause directory holding one recorded answer: the model abstained ("no changed line explains it"), for this mode and symptom.
async function abstainingRecording(mode: BrokenMode, symptom: "all_401" | "2xx_but_books_unchanged"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "doorbell-abstain-"));
  const model = answering({ category: "NOT_IN_DIFF", file: "", lineIds: [], hunkId: "" });
  const r = await diagnose(deployInput(mode, BUNDLE, symptom), { mode: "record", model: model as never, dir, gate: openGate(), log: () => undefined });
  assert.equal(r.status, "not_proven");
  return dir;
}

test("the setting-bug session: the cause is 'not proven', there is no replay and no confirmation, PayPal is not asked to verify anything, and the snapshot obeys checkSnapshot", async () => {
  const causeDir = await abstainingRecording("wrong_webhook_id_setting", "all_401");
  const world = await plantedWorld("wrong_webhook_id_setting");
  const { deps, counters } = depsOf(world, { causeDir });
  const snap = await buildLiveSnapshot(deps, world.sid, await sessionOf(world));
  assert.equal(snap.session.session.planted, true, "'planted by us' stays on a setting we broke");
  assert.equal(snap.scan!.summary.gaps, 2);
  assert.equal(snap.causes.length, 2, "one for each gap row");
  for (const c of snap.causes) {
    assert.equal(c.mode, "wrong_webhook_id_setting");
    assert.equal(c.cause.status, "not_proven");
    assert.equal(c.cause.status === "not_proven" && c.cause.reason, "model_abstained");
    assert.equal(c.replay, null, "a setting has no code to replay");
    assert.equal(c.confirmation, null);
  }
  assert.equal(counters.verify, 0, "0 verify calls");
  assert.equal(counters.loads, 0, "the witness's stored deliveries were not even read");
  assert.deepEqual(checkSnapshot(snap), []);
  assert.equal(snap.certificate!.stamp, "red");
});

test("a code bug whose cause is not proven has no replay either (a replay beside 'cause not proven' breaks checkSnapshot), and it costs no verify call", async () => {
  const causeDir = await abstainingRecording("ack_then_drop", "2xx_but_books_unchanged");
  const world = await plantedWorld("ack_then_drop");
  const { deps, counters } = depsOf(world, { causeDir });
  const snap = await buildLiveSnapshot(deps, world.sid, await sessionOf(world));
  assert.equal(snap.causes.length, 2);
  for (const c of snap.causes) assert.deepEqual([c.cause.status, c.replay, c.confirmation], ["not_proven", null, null]);
  assert.equal(counters.verify, 0);
  assert.deepEqual(checkSnapshot(snap), []);
});

test("the setting-bug session with no recorded answer is 'not diagnosed' (never a live model call), and still has no replay", async () => {
  const world = await plantedWorld("wrong_webhook_id_setting");
  const { deps, counters } = depsOf(world, { causeDir: mkdtempSync(join(tmpdir(), "doorbell-empty-")) });
  const snap = await buildLiveSnapshot(deps, world.sid, await sessionOf(world));
  for (const c of snap.causes) assert.deepEqual([c.cause.status, c.replay, c.confirmation], ["not_diagnosed", null, null]);
  assert.equal(counters.verify, 0);
  assert.deepEqual(checkSnapshot(snap), []);
});

// ---- concurrent polls share the work that is running -----------------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("two polls at once, through the coalescer, make ONE scan and ONE replay, even when the scan takes longer than the 2 s window", async () => {
  const world = await plantedWorld("ack_then_drop", { delayMs: 40 });
  const { deps, counters } = depsOf(world);
  deps.replay!.verify = async (p) => (counters.verify++, await sleep(30), world.pp.verify(p));
  const session = await sessionOf(world);
  const coalescer = createCoalescer<RunSnapshot>({ windowMs: 15 }); // the window is shorter than the work: the second poll comes after the window has passed since the START
  const first = coalescer.run(world.sid, () => buildLiveSnapshot(deps, world.sid, session));
  await sleep(25); // the scan is still running (each PayPal read takes 40 ms)
  const second = coalescer.run(world.sid, () => buildLiveSnapshot(deps, world.sid, session));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(second, first, "the second poll is the first poll's promise");
  assert.equal(a, b);
  assert.equal(world.w.paypal.calls.capture, 2, "one re-query per row, once (a second scan would make 4)");
  assert.equal(world.w.paypal.calls.list, 1, "PayPal's event list was read once");
  assert.equal(counters.verify, 4, "one replay: 2 builds x 2 deliveries");
  assert.equal(a.causes[0].replay?.basis, "replayed");
});

test("two builds at once WITHOUT the coalescer (two instances, or a route that skips it) still make one replay: the second waits for the replay that is running", async () => {
  const world = await plantedWorld("ack_then_drop", { delayMs: 5 });
  const { deps, counters } = depsOf(world);
  deps.replay!.verify = async (p) => (counters.verify++, await sleep(40), world.pp.verify(p));
  const session = await sessionOf(world);
  let asked = 0;
  const opts = { allowReplay: async () => (asked++, true) };
  const [a, b] = await Promise.all([buildLiveSnapshot(deps, world.sid, session, opts), buildLiveSnapshot(deps, world.sid, session, opts)]);
  assert.equal(world.w.paypal.calls.capture, 4, "two scans (no coalescer here)");
  assert.equal(counters.verify, 4, "but one replay: 4 verify calls, not 8");
  assert.equal(asked, 1, "and the replay limit was asked once: the session's 3 replays an hour are not spent twice");
  assert.deepEqual(a.causes[0].replay, b.causes[0].replay);
  assert.equal(deps.replay!.inflight!.size, 0, "nothing is left marked as running");
  // a replay that failed to start is not left running either
  deps.replay!.cache!.clear();
  deps.replay!.witness = () => ({
    attempts: async () => {
      throw new Error("redis down");
    },
  });
  const c = await buildLiveSnapshot(deps, world.sid, session);
  assert.equal(c.causes[0].replay?.basis, "recorded");
  assert.equal(deps.replay!.inflight!.size, 0);
});
