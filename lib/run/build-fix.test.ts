// "Prove the fix" in the live snapshot: the recorded fix rides next to a cause that is proposed AND confirmed by the replay, only for a patch the
// owner has reviewed, and never costs a model call, a process or a verify call. Offline, with the gap finder's stand-ins (as build.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose } from "../cause/cause.ts";
import { answering, openGate, ROOT } from "../cause/test-helpers.ts";
import type { RecordedReplays } from "../cause/replay.ts";
import type { FixStore } from "../fix/recorded.ts";
import { fixViolations } from "../fix/rules.ts";
import { confirmedCause, plantedWorld, provenFix } from "../fix/test-helpers.ts";
import type { FixResult } from "../fix/types.ts";
import { computeDiffs } from "../shop/diffs.ts";
import { SHOP_WEBHOOK_ID } from "../shop/test-helpers.ts";
import type { PlantedMode } from "../shop/types.ts";
import { checkSnapshot } from "../ui/check.ts";
import { buildLiveSnapshot, type SnapshotDeps } from "./build.ts";
import { deployInput } from "./deploy-input.ts";

const BUNDLE = computeDiffs(ROOT);
const RECORDED = JSON.parse(readFileSync(join(ROOT, "fixtures/replay/recorded.json"), "utf8")) as RecordedReplays;
const MODES: PlantedMode[] = ["ack_then_drop", "bad_body", "last_write_wins"];

function depsOf(world: Awaited<ReturnType<typeof plantedWorld>>, over: Partial<SnapshotDeps> = {}) {
  const counters = { verify: 0 };
  const deps: SnapshotDeps = {
    scan: world.w.deps(),
    bundle: BUNDLE,
    recordedReplays: RECORDED,
    replay: {
      witness: () => ({ attempts: async (tid: string) => (world.stored.has(tid) ? [world.stored.get(tid)!] : []) }),
      webhookIdOf: () => SHOP_WEBHOOK_ID,
      verify: async (p) => (counters.verify++, world.pp.verify(p)),
      cache: new Map(),
      inflight: new Map(),
    },
    log: () => undefined,
    ...over,
  };
  return { deps, counters };
}

const sessionOf = async (world: Awaited<ReturnType<typeof plantedWorld>>) => (await world.w.store.getSession(world.sid))!;

// Fix results for the recorded cause of every planted mode, approved or not.
async function storeFor(approved: PlantedMode[]): Promise<FixStore> {
  const results: FixStore["results"] = {};
  const reviewed: FixStore["reviewed"] = {};
  for (const mode of MODES) {
    const { cause } = await confirmedCause(mode, RECORDED);
    const { result } = await provenFix(mode, cause.requestHash);
    results[mode] = result;
    if (approved.includes(mode)) reviewed[mode] = result.patchSha256;
  }
  return { results, reviewed };
}

for (const mode of MODES) {
  test(`${mode}: a reviewed fix rides beside every confirmed cause, recorded, with no model call and no extra verify call, and the snapshot obeys the rules`, async () => {
    const world = await plantedWorld(mode);
    const { deps, counters } = depsOf(world, { fix: { store: await storeFor([mode]) } });
    // the baseline has no reviewed patch, whatever the repo's own fixtures/fix/reviewed.json holds (the owner has approved real ones)
    const without = depsOf(world, { fix: { store: await storeFor([]) } });
    const snap = await buildLiveSnapshot(deps, world.sid, await sessionOf(world));
    const base = await buildLiveSnapshot(without.deps, world.sid, await sessionOf(world));
    assert.equal(snap.causes.length, 2);
    for (const c of snap.causes) {
      assert.equal(c.confirmation?.confirmed, true);
      assert.equal(c.fix?.mode, mode);
      assert.equal(c.fix?.verdict, "proven");
      assert.equal(c.fix?.basis, "recorded");
      assert.equal(c.fix?.source, "recording");
      assert.equal(c.cause.status === "proposed" && c.fix?.causeRequestHash, c.cause.status === "proposed" && c.cause.requestHash);
      assert.deepEqual(fixViolations(c), []);
    }
    assert.equal(snap.causes[0].fix, snap.causes[1].fix, "the rows of a mode share one fix");
    assert.equal(counters.verify, without.counters.verify, "the fix costs no verify call");
    assert.deepEqual(checkSnapshot(snap), []);
    // the rest of the snapshot is what it was without the fix
    assert.deepEqual(snap.causes.map((c) => [c.captureId, c.cause, c.confirmation]), base.causes.map((c) => [c.captureId, c.cause, c.confirmation]));
    assert.ok(base.causes.every((c) => c.fix === undefined));
  });
}

test("a patch the owner has not reviewed is not in the snapshot", async () => {
  const world = await plantedWorld("ack_then_drop");
  const snap = await buildLiveSnapshot(depsOf(world, { fix: { store: await storeFor([]) } }).deps, world.sid, await sessionOf(world));
  assert.ok(snap.causes.length > 0);
  assert.ok(snap.causes.every((c) => !("fix" in c)));
  const other = await buildLiveSnapshot(depsOf(world, { fix: { store: await storeFor(["bad_body", "last_write_wins"]) } }).deps, world.sid, await sessionOf(world));
  assert.ok(other.causes.every((c) => !("fix" in c)), "another mode's approval does not open this mode's patch");
});

test("a fix for another cause than the one in the snapshot is not shown", async () => {
  const world = await plantedWorld("ack_then_drop");
  const store = await storeFor(["ack_then_drop"]);
  store.results.ack_then_drop = { ...store.results.ack_then_drop!, causeRequestHash: "d".repeat(64) };
  const snap = await buildLiveSnapshot(depsOf(world, { fix: { store } }).deps, world.sid, await sessionOf(world));
  assert.ok(snap.causes.every((c) => !("fix" in c)));
});

test("no fix beside a cause that the replay did not confirm", async () => {
  const world = await plantedWorld("ack_then_drop", 1);
  const store = await storeFor(["ack_then_drop"]);
  const { deps } = depsOf(world, { recordedReplays: {}, replay: undefined, fix: { store } });
  const snap = await buildLiveSnapshot(deps, world.sid, await sessionOf(world));
  assert.equal(snap.causes[0].cause.status, "proposed");
  assert.equal(snap.causes[0].confirmation?.confirmed, false);
  assert.ok(!("fix" in snap.causes[0]));
});

test("no fix beside a cause that is not proven or not diagnosed, and none for the setting bug", async () => {
  // the model abstained: the cause is 'not proven'
  const dir = mkdtempSync(join(tmpdir(), "doorbell-abstain-"));
  await diagnose(deployInput("ack_then_drop", BUNDLE, "2xx_but_books_unchanged"), { mode: "record", model: answering({ category: "NOT_IN_DIFF", file: "", lineIds: [], hunkId: "" }) as never, dir, gate: openGate(), log: () => undefined });
  const world = await plantedWorld("ack_then_drop");
  const store = await storeFor(MODES);
  const notProven = await buildLiveSnapshot(depsOf(world, { causeDir: dir, fix: { store } }).deps, world.sid, await sessionOf(world));
  for (const c of notProven.causes) assert.deepEqual([c.cause.status, "fix" in c], ["not_proven", false]);
  // no recording at all: 'not diagnosed'
  const empty = await buildLiveSnapshot(depsOf(world, { causeDir: mkdtempSync(join(tmpdir(), "doorbell-empty-")), fix: { store } }).deps, world.sid, await sessionOf(world));
  for (const c of empty.causes) assert.deepEqual([c.cause.status, "fix" in c], ["not_diagnosed", false]);
  // the setting bug has no code: its cause is not proven, and a fix for it does not exist
  const setting = await plantedWorld("wrong_webhook_id_setting");
  const s = await buildLiveSnapshot(depsOf(setting, { fix: { store } }).deps, setting.sid, await sessionOf(setting));
  for (const c of s.causes) assert.equal("fix" in c, false);
  assert.deepEqual(checkSnapshot(s), []);
});

test("a fixed session (the good handler) shows no cause and so no fix", async () => {
  const world = await plantedWorld("ack_then_drop");
  await world.w.store.setMode(world.sid, "good");
  const snap = await buildLiveSnapshot(depsOf(world, { fix: { store: await storeFor(MODES) } }).deps, world.sid, await sessionOf(world));
  assert.deepEqual(snap.causes, []);
});

test("record time: fix.prove runs once per mode and its result replaces the recorded one; null or a throw leaves the recorded result", async () => {
  const world = await plantedWorld("last_write_wins");
  const store = await storeFor(["last_write_wins"]);
  let calls = 0;
  const fresh = (recorded: FixResult): FixResult => ({ ...recorded, basis: "replayed", ranAt: 123 });
  const proving = depsOf(world, { fix: { store, prove: async ({ recorded, mode, scan }) => (calls++, assert.equal(mode, "last_write_wins"), assert.equal(scan.rows.length, 2), fresh(recorded)) } });
  const snap = await buildLiveSnapshot(proving.deps, world.sid, await sessionOf(world));
  assert.equal(calls, 1, "once for the two rows");
  assert.deepEqual(snap.causes.map((c) => [c.fix?.basis, c.fix?.ranAt]), [["replayed", 123], ["replayed", 123]]);

  const logged: string[] = [];
  const none = await buildLiveSnapshot(depsOf(world, { fix: { store, prove: async () => null } }).deps, world.sid, await sessionOf(world));
  assert.ok(none.causes.every((c) => c.fix?.basis === "recorded"));
  const broken = await buildLiveSnapshot(depsOf(world, { log: (l) => logged.push(String(l.outcome)), fix: { store, prove: async () => { throw new Error("PayPal unreachable"); } } }).deps, world.sid, await sessionOf(world));
  assert.ok(broken.causes.every((c) => c.fix?.basis === "recorded"));
  assert.deepEqual(logged, ["fix_unavailable"]);
});
