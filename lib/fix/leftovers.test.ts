// What a patch leaves behind: found by diffing the patched file against the last good build, said in fixed words. The three committed patches are the
// real cases; the small ones show where the kinds end (a name the file still uses is not a leftover, a changed line of code is not a comment).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readPatched, readResults } from "./files.ts";
import { leftoversOf } from "./leftovers.ts";
import { buildResult, sha256 } from "./result.ts";
import { fixViolations } from "./rules.ts";
import { checkFix } from "./check.ts";
import { RECORDED_SCENARIOS } from "../run/recorded.ts";
import { carefulFix, confirmedCause, FILE_OF, GOOD, plantedTarget, provenFix } from "./test-helpers.ts";
import { CANNOT_SEE, leftoverText, leftoversLine, type Leftover } from "./types.ts";
import type { RecordedReplays } from "../cause/replay.ts";
import { MODEL_ID } from "../core/llm.ts";
import type { GapCause } from "../run/snapshot.ts";
import type { PlantedMode } from "../shop/types.ts";
import recorded from "../../fixtures/replay/recorded.json" with { type: "json" };

const RECORDED = recorded as unknown as RecordedReplays;
const MODES: PlantedMode[] = ["ack_then_drop", "bad_body", "last_write_wins"];
const patchedOf = (mode: PlantedMode): string => readPatched(mode)!;

test("the three reviewed patches leave what the owner was shown: a comment and an unused value, an unused function, imports on two lines", () => {
  assert.deepEqual(leftoversOf(GOOD, patchedOf("ack_then_drop")), [{ kind: "comment", lines: 1 }, { kind: "unused", name: "queue", declares: "value" }]);
  assert.deepEqual(leftoversOf(GOOD, patchedOf("bad_body")), [{ kind: "unused", name: "canonical", declares: "function" }]);
  assert.deepEqual(leftoversOf(GOOD, patchedOf("last_write_wins")), [{ kind: "imports" }]);
});

test("a file that equals the last good build leaves nothing", () => {
  assert.deepEqual(leftoversOf(GOOD, GOOD), []);
  assert.equal(leftoversLine([]), "Compared with the shop's last good build, nothing else differs.");
});

test("a declaration the rest of the file still uses is not a leftover, and neither is a changed line of code a comment", () => {
  const used = GOOD.replace("  return { status: 200 };\n};", "  return { status: queue.length };\n};\n\nconst queue: unknown[] = [];");
  assert.deepEqual(leftoversOf(GOOD, used), [{ kind: "other", added: 1, removed: 1 }, { kind: "other", added: 2, removed: 0 }], "queue is read by the changed return, so its declaration (a blank and the line) is not called unused");
  const changed = GOOD.replace("at: ctx.now() }", "at: 0 }");
  assert.deepEqual(leftoversOf(GOOD, changed), [{ kind: "other", added: 1, removed: 1 }]);
  const names = GOOD.replace('import { bookingOf, rank } from "../lib/shop/events.ts";', 'import { bookingOf } from "../lib/shop/events.ts";');
  assert.deepEqual(leftoversOf(GOOD, names), [{ kind: "other", added: 1, removed: 1 }], "an import that names different things is not just written differently");
});

test("a recursive helper that nothing else calls is unused: its own calls do not count", () => {
  const p = `${GOOD}\nfunction walk(v: any): any {\n  return Array.isArray(v) ? v.map(walk) : v;\n}\n`;
  assert.deepEqual(leftoversOf(GOOD, p), [{ kind: "unused", name: "walk", declares: "function" }]);
  const called = p.replace("const booking = bookingOf(event);", "const booking = bookingOf(walk(event));");
  assert.deepEqual(leftoversOf(GOOD, called).map((l) => l.kind), ["other", "other"], "walk is called by the handler: not a leftover");
});

test("the sentences are fixed words with a name and counts, in a line and in the sentence about what no check sees", () => {
  const items: Leftover[] = [{ kind: "comment", lines: 1 }, { kind: "unused", name: "queue", declares: "value" }];
  assert.equal(leftoversLine(items), "Compared with the shop's last good build, the patch still has: a comment that may no longer match the code; “queue”, a value nothing reads.");
  assert.equal(leftoverText({ kind: "comment", lines: 3 }), "3 comments that may no longer match the code");
  assert.equal(leftoverText({ kind: "unused", name: "canonical", declares: "function" }), "“canonical”, a function nothing calls");
  assert.equal(leftoverText({ kind: "imports" }), "the imports written differently, naming the same things");
  assert.equal(leftoverText({ kind: "other", added: 2, removed: 1 }), "3 other changed lines (2 added, 1 removed)");
  assert.equal(CANNOT_SEE, "The checks do not look at comments or leftover code.");
});

test("a result carries its leftovers when it knows the good build, only when proven, and the rules check what it carries", async () => {
  for (const mode of MODES) {
    const { result, patched } = await provenFix(mode, "c".repeat(64));
    assert.deepEqual(result.leftovers, leftoversOf(GOOD, patched), mode);
    assert.deepEqual(fixViolations(await gapCause(mode, result)), [], mode);
  }
  // not proven: the checks failed, so there is no patch and nothing to compare
  const t = plantedTarget("bad_body");
  const failed = checkFix(t, new Set(), []);
  const r = buildResult({ mode: "bad_body", causeRequestHash: "c".repeat(64), fixRequestHash: "f".repeat(64), promptVersion: "fix-v1", model: MODEL_ID, recordedAt: 1, ranAt: 2, basis: "replayed", file: FILE_OF.bad_body, bad: t.bad, good: GOOD, checks: failed, patched: failed.patched, orders: 2 });
  assert.equal(r.verdict, "not_proven");
  assert.equal("leftovers" in r, false);
  // an older result has none, and is sound without
  const { result } = await provenFix("ack_then_drop", "c".repeat(64));
  const { leftovers: _dropped, ...older } = result;
  assert.deepEqual(fixViolations(await gapCause("ack_then_drop", older)), []);
  const bad = async (leftovers: unknown) => fixViolations(await gapCause("ack_then_drop", { ...result, leftovers: leftovers as Leftover[] })).join("|");
  assert.match(await bad([{ kind: "unused", name: "x; drop table", declares: "value" }]), /not one that leftovers.ts makes/);
  assert.match(await bad([{ kind: "comment", lines: 0 }]), /not one that leftovers.ts makes/);
  assert.match(await bad([{ kind: "mystery" }]), /not one that leftovers.ts makes/);
  assert.match(fixViolations(await gapCause("ack_then_drop", { ...result, verdict: "not_proven", claim: "Fix not proven.", patch: null, baseline: null, orders: 0, inputs: 0, controls: result.controls.map((c) => ({ ...c, ok: false })) })).join("|"), /not proven, but it lists leftovers/);
});

async function gapCause(mode: PlantedMode, fix: NonNullable<GapCause["fix"]>): Promise<GapCause> {
  const base = await confirmedCause(mode, RECORDED);
  return { captureId: "CAP1", mode: base.mode, cause: base.cause, replay: base.replay, confirmation: base.confirmation, fix: { ...fix, causeRequestHash: base.cause.requestHash } };
}

test("fixtures/fix/results.json holds the leftovers of each reviewed patched file (scripts/fix-leftovers.ts writes them)", () => {
  const results = readResults();
  assert.deepEqual(Object.keys(results).sort(), [...MODES].sort());
  for (const mode of MODES) {
    const r = results[mode]!;
    assert.equal(r.verdict, "proven", mode);
    assert.deepEqual(r.leftovers, leftoversOf(GOOD, patchedOf(mode)), `${mode}: run npx tsx scripts/fix-leftovers.ts`);
  }
});

test("every proven fix in the recorded runs carries the leftovers of its reviewed patched file (npx tsx scripts/fix-leftovers.ts adds them to a recording made without)", () => {
  let seen = 0;
  for (const sc of RECORDED_SCENARIOS) {
    for (const step of sc.steps) {
      for (const c of step.causes) {
        if (!c.fix || c.fix.verdict !== "proven") continue;
        seen++;
        assert.equal(sha256(patchedOf(c.fix.mode)), c.fix.patchSha256, `${sc.id}: the recording's patch is the reviewed file`);
        assert.deepEqual(c.fix.leftovers, leftoversOf(GOOD, patchedOf(c.fix.mode)), `${sc.id}: run npx tsx scripts/fix-leftovers.ts`);
      }
    }
  }
  assert.ok(seen >= 4, `${seen} proven fixes in the recorded runs`);
});
