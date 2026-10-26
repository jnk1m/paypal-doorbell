// The committed fix files (fixtures/fix/, fixtures/fix-recordings/) are what the owner reviewed, what the screen shows and what a deployed function
// serves. These tests tie the four together offline, with no model call and no PayPal call: the recorded model answer, applied to the bad deploy,
// gives the patched file; the patched file gives the diff on the screen; the request that was recorded is the request the product would send now;
// and the committed patched file still passes the referee on signed stand-in events when it runs in the sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSource } from "../cause/hygiene.ts";
import type { RecordedReplays } from "../cause/replay.ts";
import { costUsd, MODEL_ID } from "../core/llm.ts";
import type { GapCause } from "../run/snapshot.ts";
import { deleteVerify } from "./baselines.ts";
import { checkFix, fixTarget } from "./check.ts";
import { FixOutput } from "./edits.ts";
import { FIX_RECORDINGS, readPatched, readResults, readReviewed } from "./files.ts";
import { fixRequestHash } from "./llm.ts";
import { buildFixRequest } from "./prompt.ts";
import { CachedVerifier, Referee } from "./referee.ts";
import { patchView, sha256 } from "./result.ts";
import { fixViolations } from "./rules.ts";
import { confirmedCause, FILE_OF, GOOD, ROOT, world } from "./test-helpers.ts";
import { claimOf, FIX_CHECK_IDS, FIX_CONTROL_IDS } from "./types.ts";
import recorded from "../../fixtures/replay/recorded.json" with { type: "json" };

const RECORDED = recorded as unknown as RecordedReplays;
const results = readResults();
const modes = Object.keys(results) as (keyof typeof FILE_OF)[];

test("results.json holds only the planted modes, each result for its own mode", () => {
  for (const [mode, r] of Object.entries(results)) {
    assert.ok(mode in FILE_OF, mode);
    assert.equal(r.mode, mode);
    assert.equal(r.source, "recording");
    assert.equal(r.model, MODEL_ID);
  }
});

test("reviewed.json approves only patched files that exist, byte for byte", () => {
  for (const [mode, sha] of Object.entries(readReviewed())) {
    const r = results[mode as keyof typeof results];
    assert.ok(r, `${mode}: an approval without a result`);
    assert.equal(sha, r.patchSha256, `${mode}: the approval is of another file than the result`);
    assert.equal(sha256(readPatched(mode as keyof typeof FILE_OF) ?? ""), sha, `${mode}: the patched file on disk is not the approved one`);
  }
});

for (const mode of modes) {
  test(`${mode}: recorded answer -> patched file -> diff on the screen -> request, all the same thing`, async () => {
    const r = results[mode]!;
    const { cause, input, symptom } = await confirmedCause(mode, RECORDED);
    assert.equal(r.causeRequestHash, cause.requestHash, "the fix answers the recorded cause");

    // the recording of the model's answer exists and is the request the product would send now
    const bad = input.files[0];
    const req = buildFixRequest({ diff: input.diff, badPath: bad.path, badText: bad.text, symptom, category: cause.category, cited: cause.lines });
    assert.equal(fixRequestHash(req), r.fixRequestHash, "the prompt, the diff or the model changed since the answer was recorded: record it again");
    const file = join(FIX_RECORDINGS, `${r.fixRequestHash}.json`);
    assert.ok(existsSync(file), `${file} is missing`);
    const rec = JSON.parse(readFileSync(file, "utf8")) as { model: string; version: string; system: string; prompt: string; usage: { inputTokens: number; outputTokens: number; reasoningTokens: number }; output: unknown };
    assert.equal(rec.model, MODEL_ID);
    assert.equal(rec.version, r.promptVersion);
    assert.equal(rec.system, req.system);
    assert.equal(rec.prompt, req.prompt);
    assert.ok(costUsd(rec.usage) < 0.05, "one fix call costs cents");

    // the recorded edits, applied to the bad deploy, give the patched file; the checks pass again
    const edits = FixOutput.parse(rec.output).edits;
    const checked = checkFix(fixTarget(input.diff, bad.text), new Set(cause.lines.map((l) => l.id)), edits);
    assert.deepEqual(checked.rows.map((c) => [c.id, c.ok]), FIX_CHECK_IDS.map((id) => [id, true]));
    assert.equal(r.verdict, "proven");
    assert.equal(sha256(checked.patched!), r.patchSha256);

    // the patched file on disk is that file, and the diff in the result is its diff against the bad deploy
    const onDisk = readPatched(mode);
    assert.equal(onDisk, checked.patched, "fixtures/fix/patched is not what the recorded edits make");
    assert.equal(bad.text, normalizeSource(readFileSync(join(ROOT, FILE_OF[mode]), "utf8")).text);
    assert.deepEqual(r.patch, patchView(bad.path, bad.text, onDisk!));
    assert.deepEqual(r.checks.map((c) => c.id), [...FIX_CHECK_IDS]);
    assert.deepEqual(r.controls.map((c) => c.id), [...FIX_CONTROL_IDS]);
    assert.equal(r.claim, claimOf(r.orders, r.inputs));
  });

  test(`${mode}: the committed patched file passes the referee in the sandbox on signed stand-in events, and the same file without its signature check fails the tampered control`, async () => {
    const patched = readPatched(mode)!;
    const w = world();
    const ref = new Referee(w.scenarios, GOOD, new CachedVerifier(w.paypal.verify));
    await ref.prepare();
    const judged = await ref.judge(patched);
    assert.ok(judged.pass, JSON.stringify(judged.controls));
    assert.deepEqual((await ref.judge(deleteVerify(patched))).controls, { real: true, reversed: true, tampered: false, paypal: true });
  });

  test(`${mode}: the result obeys the rules next to its own recorded, confirmed cause`, async () => {
    const base = await confirmedCause(mode, RECORDED);
    const gc: GapCause = { captureId: "CAP1", mode, cause: base.cause, replay: base.replay, confirmation: base.confirmation, fix: results[mode] };
    assert.deepEqual(fixViolations(gc), []);
  });
}

// DO NOT CHANGE 3: nothing a screen shows may claim more than was proven.
const FORBIDDEN = ["complete", "nothing missing", "all tied", "every", "no gaps", "all clear", "fully", "correct"];
test("the fix results hold none of the words the plan forbids, nor 'correct'", () => {
  const found: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      for (const w of FORBIDDEN) if (new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`, "i").test(v)) found.push(`${path}: "${w}" in "${v.slice(0, 80)}"`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(results, "$");
  assert.deepEqual(found, []);
});
