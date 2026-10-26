// The fix result a screen reads: how it is built from the checks and the referee, and the rules it must obey next to a cause.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFix } from "./check.ts";
import { CachedVerifier, Referee } from "./referee.ts";
import { buildResult, patchView } from "./result.ts";
import { fixViolations } from "./rules.ts";
import { carefulFix, confirmedCause, E, FILE_OF, GOOD, idOf, plantedTarget, provenFix, text, world } from "./test-helpers.ts";
import { CHECK_LABEL, CONTROL_LABEL, FIX_CONTROL_IDS, NOT_PROVEN_FIX_TEXT, claimOf } from "./types.ts";
import type { RecordedReplays } from "../cause/replay.ts";
import { MODEL_ID } from "../core/llm.ts";
import type { GapCause } from "../run/snapshot.ts";
import type { PlantedMode } from "../shop/types.ts";
import recorded from "../../fixtures/replay/recorded.json" with { type: "json" };

const RECORDED = recorded as unknown as RecordedReplays;
const MODES: PlantedMode[] = ["ack_then_drop", "bad_body", "last_write_wins"];

test("patchView is the diff from the bad file to the patched file: changed lines with their context, counted", async () => {
  const { result, patched } = await provenFix("bad_body", "c".repeat(64));
  const bad = text(FILE_OF.bad_body);
  const view = patchView(FILE_OF.bad_body, bad, patched);
  assert.deepEqual(result.patch, view);
  assert.equal(view.file, "handlers/bad-body.ts");
  assert.deepEqual([view.added, view.removed], [1, 1]); // the canonical() call is replaced; the helper function stays (the cause did not cite it)
  assert.deepEqual(view.hunks[0].filter((l) => l.kind !== "ctx"), [{ kind: "del", text: "  const event = canonical(JSON.parse(ctx.rawBody));" }, { kind: "add", text: "  const event = JSON.parse(ctx.rawBody);" }]);
  assert.equal(patchView("f", bad, bad).hunks.length, 0, "an unchanged file has no hunks");
});

for (const mode of MODES) {
  test(`${mode}: a proven result carries the patch, five passing checks, four passing controls, the fixed claim, and a baseline that the tampered control catches`, async () => {
    const { result } = await provenFix(mode, "c".repeat(64));
    assert.equal(result.verdict, "proven");
    assert.equal(result.source, "recording");
    assert.equal(result.model, MODEL_ID);
    assert.deepEqual(result.checks.map((c) => [c.id, c.ok, c.label]), Object.entries(CHECK_LABEL).map(([id, label]) => [id, true, label]));
    assert.deepEqual(result.controls.map((c) => [c.id, c.ok, c.label]), Object.entries(CONTROL_LABEL).map(([id, label]) => [id, true, label]));
    assert.deepEqual(result.controls.map((c) => c.n), [4, 4, 4, 4], "2 orders x 2 deliveries per control; the PayPal control compares 2 orders x (arrival order, reversed)");
    assert.equal(result.inputs, 12);
    assert.equal(result.orders, 2);
    assert.equal(result.claim, claimOf(2, 12));
    assert.ok(result.patch && result.patch.hunks.length > 0);
    assert.equal(result.patchSha256.length, 64);
    const tampered = result.baseline!.controls.find((c) => c.id === "tampered")!;
    assert.equal(tampered.ok, false, "the patch without its signature check books the tampered copies");
    assert.ok(result.baseline!.controls.filter((c) => c.id !== "tampered").every((c) => c.ok));
  });
}

test("a patch that fails a code check is not proven: no patch, no baseline, the controls were not run", () => {
  const t = plantedTarget("bad_body");
  const bug = idOf(t, "add", "canonical(JSON.parse");
  const checked = checkFix(t, new Set([bug]), [E("replace", bug, "  const event = JSON.parse(process.env.X);")]);
  const r = buildResult({ mode: "bad_body", causeRequestHash: "c".repeat(64), fixRequestHash: "f".repeat(64), promptVersion: "fix-v1", model: MODEL_ID, recordedAt: 1, ranAt: 2, basis: "replayed", file: FILE_OF.bad_body, bad: t.bad, checks: checked, patched: checked.patched, orders: 2 });
  assert.equal(r.verdict, "not_proven");
  assert.equal(r.claim, NOT_PROVEN_FIX_TEXT);
  assert.equal(r.patch, null);
  assert.equal(r.baseline, null);
  assert.deepEqual(r.checks.map((c) => c.ok), [true, true, false, true, true]);
  assert.deepEqual(r.controls.map((c) => [c.ok, c.n]), FIX_CONTROL_IDS.map(() => [false, 0]));
  assert.deepEqual([r.orders, r.inputs], [0, 0]);
});

test("a patch that passes the code checks but fails a replay control is not proven either, and shows no code", async () => {
  const t = plantedTarget("last_write_wins");
  const fix = carefulFix("last_write_wins", t);
  // only the import comes back, the guard does not: it parses, it stays inside the hunks, and it overwrites a refund with a late payment
  const checked = checkFix(t, new Set(fix.cited), [fix.edits[0]]);
  assert.ok(checked.ok);
  const w = world();
  const ref = new Referee(w.scenarios, GOOD, new CachedVerifier(w.paypal.verify));
  await ref.prepare();
  const judged = await ref.judge(checked.patched!);
  assert.equal(judged.pass, false);
  const r = buildResult({ mode: "last_write_wins", causeRequestHash: "c".repeat(64), fixRequestHash: "f".repeat(64), promptVersion: "fix-v1", model: MODEL_ID, recordedAt: 1, ranAt: 2, basis: "replayed", file: FILE_OF.last_write_wins, bad: t.bad, checks: checked, patched: checked.patched, referee: judged, orders: ref.scenarioCount });
  assert.equal(r.verdict, "not_proven");
  assert.equal(r.patch, null);
  assert.deepEqual(r.controls.map((c) => c.ok), [true, false, true, false], "arrival order fine, reversed wrong, tampered fine, PayPal's answer wrong");
});

// ---- the rules (the fix part of checkSnapshot) --------------------------------------------------------------------------------------------

async function causeWith(mode: PlantedMode) {
  const base = await confirmedCause(mode, RECORDED);
  const hash = base.cause.requestHash;
  const { result } = await provenFix(mode, hash);
  const gc = (over: Partial<GapCause> = {}): GapCause => ({ captureId: "CAP1", ...base, fix: result, ...over });
  return { gc, result, hash };
}

test("rules: a proven fix next to a proposed, replay-confirmed cause of the same mode is sound", async () => {
  for (const mode of MODES) {
    const { gc } = await causeWith(mode);
    assert.deepEqual(fixViolations(gc()), [], mode);
  }
  const { gc } = await causeWith("ack_then_drop");
  assert.deepEqual(fixViolations(gc({ fix: undefined })), [], "no fix is fine");
});

test("rules: a fix beside a cause that is not proposed, not confirmed, for another mode or another cause is refused", async () => {
  const { gc, result } = await causeWith("ack_then_drop");
  const notProven = { status: "not_proven" as const, reason: "model_abstained" as const, promptVersion: "cause-v1", requestHash: "x", text: "Cause not proven." as const };
  assert.match(fixViolations(gc({ cause: notProven, confirmation: null, replay: null })).join("|"), /the cause is not_proven/);
  assert.match(fixViolations(gc({ confirmation: { confirmed: false, chip: "NOT CONFIRMED" } })).join("|"), /not confirmed by the replay/);
  assert.match(fixViolations(gc({ mode: "bad_body" })).join("|"), /it is for mode ack_then_drop, the cause is for bad_body/);
  assert.match(fixViolations(gc({ fix: { ...result, causeRequestHash: "d".repeat(64) } })).join("|"), /answers another cause/);
});

test("rules: proven means every check and control passed, the patch and the baseline are there, the claim is the fixed sentence", async () => {
  const { gc, result } = await causeWith("bad_body");
  const bad = (fix: Partial<typeof result>) => fixViolations(gc({ fix: { ...result, ...fix } })).join("|");
  assert.match(bad({ checks: result.checks.map((c, i) => (i === 1 ? { ...c, ok: false } : c)) }), /proven, but a check failed/);
  assert.match(bad({ controls: result.controls.map((c, i) => (i === 2 ? { ...c, ok: false } : c)) }), /a control failed or was not run/);
  assert.match(bad({ controls: result.controls.map((c) => ({ ...c, n: 0 })) }), /a control failed or was not run/);
  assert.match(bad({ patch: null }), /no patch to show/);
  assert.match(bad({ baseline: null }), /baseline is missing/);
  assert.match(bad({ baseline: { ...result.baseline!, controls: result.baseline!.controls.map((c) => ({ ...c, ok: true })) } }), /did not catch the patch without its signature check/);
  assert.match(bad({ baseline: { ...result.baseline!, controls: result.baseline!.controls.map((c) => ({ ...c, ok: false })) } }), /baseline must pass the replay/);
  assert.match(bad({ claim: "The fix is correct." }), /not the fixed sentence/);
  assert.match(bad({ source: "live" as never }), /a patch comes from a recording/);
  assert.match(bad({ model: "" }), /does not say which model/);
});

test("rules: a fix that is not proven shows no code, and says so in the fixed words", async () => {
  const { gc, result: proven } = await causeWith("bad_body");
  const { leftovers: _leftovers, ...result } = proven; // buildResult gives a result that was not proven no leftovers: there is no patch to compare
  const notProven = { ...result, verdict: "not_proven" as const, claim: NOT_PROVEN_FIX_TEXT, patch: null, baseline: null, orders: 0, inputs: 0, controls: result.controls.map((c) => ({ ...c, ok: false })) };
  assert.deepEqual(fixViolations(gc({ fix: notProven })), []);
  assert.match(fixViolations(gc({ fix: { ...notProven, patch: result.patch } })).join("|"), /not proven, but it carries a patch/);
  assert.match(fixViolations(gc({ fix: { ...notProven, claim: result.claim } })).join("|"), /not proven, but the claim says/);
});

test("rules: a patch line that is not plain ASCII is refused", async () => {
  const { gc, result } = await causeWith("bad_body");
  const patch = { ...result.patch!, hunks: [[...result.patch!.hunks[0], { kind: "add" as const, text: "  // café" }]] };
  assert.match(fixViolations(gc({ fix: { ...result, patch } })).join("|"), /not plain ASCII/);
});
