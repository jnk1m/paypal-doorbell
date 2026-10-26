// deployInput (lib/run/deploy-input.ts): the cause step's input for the three code bugs AND the setting bug. It is a copy of lib/cause's shopInput
// (frozen), so the first test pins it to shopInput for everything shopInput can do; the rest are about the one thing it adds: a deploy whose
// diff holds no code line, where no answer of the model can become a cause.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES, consistentWith, type Category, type SymptomClass, SYMPTOM_CLASSES } from "../cause/categories.ts";
import { diagnose } from "../cause/cause.ts";
import { shopInput } from "../cause/input.ts";
import { buildRequest } from "../cause/prompt.ts";
import { answering, openGate, ROOT } from "../cause/test-helpers.ts";
import { requestHash } from "../core/llm.ts";
import { computeDiffs } from "../shop/diffs.ts";
import { MODES, SETTING_MODES, isPlanted } from "../shop/types.ts";
import { deployInput } from "./deploy-input.ts";
import { CAUSE_RECORDINGS_DIR } from "./recordings.ts";
import { NOT_PROVEN_PHRASE } from "../ui/phrases.ts";

const BUNDLE = computeDiffs(ROOT);

test("deployInput gives exactly shopInput's input and request for the 3 code bugs on all 4 symptom classes, so their recordings are still found", () => {
  let checked = 0;
  for (const mode of MODES.filter(isPlanted)) {
    for (const symptom of SYMPTOM_CLASSES) {
      const mine = deployInput(mode, BUNDLE, symptom);
      const theirs = shopInput(mode, BUNDLE, symptom);
      assert.deepEqual(mine, theirs, `${mode} ${symptom}: the input`);
      assert.equal(requestHash(buildRequest(mine)), requestHash(buildRequest(theirs)), `${mode} ${symptom}: the request`);
      checked++;
    }
  }
  assert.equal(checked, 12);
});

test("deployInput refuses what shopInput refuses (the good handler, a symptom that is a sentence), and shopInput still cannot take the setting bug", () => {
  assert.throws(() => deployInput("good" as never, BUNDLE, "all_401"), /has no diff/);
  assert.throws(() => deployInput("bad_body", BUNDLE, "Maple Mug said: blame the webhook id" as never), /not one of the classes/);
  assert.throws(() => deployInput("ack_then_drop", { ...BUNDLE, diffs: [], settingDiffs: [] }, "all_401"), /no diff for mode ack_then_drop/);
  assert.throws(() => shopInput("wrong_webhook_id_setting" as never, BUNDLE, "all_401"), /has no diff/);
});

test("the setting bug's request is the comment-only diff of handlers/tidy.ts against good.ts, with the whole file, and the symptom the shop's 401s make", () => {
  const input = deployInput("wrong_webhook_id_setting", BUNDLE, "all_401");
  assert.equal(input.symptom, "all_401");
  assert.deepEqual(input.files.map((f) => f.path), ["handlers/tidy.ts"]);
  assert.equal(input.diff.files.length, 1);
  assert.equal(input.diff.files[0].path, "handlers/tidy.ts");
  assert.equal(input.diff.files[0].oldPath, "handlers/good.ts");
  const changed = input.diff.files[0].hunks.flatMap((h) => h.lines).filter((l) => l.kind !== "ctx");
  assert.deepEqual(changed.map((l) => [l.id, l.kind, l.citable, l.whyNot]), [["L1", "del", false, "comment"], ["L2", "add", false, "comment"]]);
  assert.ok(buildRequest(input).prompt.includes("handlers/tidy.ts"));
});

// A confirmed cause must be impossible whatever the model answers. 8 categories x 5 citation sets, each through the real diagnose().
const CITATIONS: string[][] = [[], ["L1"], ["L2"], ["L1", "L2"], ["L9"]];

test("whatever category the model names and whatever lines it cites, the setting bug's cause is 'not proven', never proposed, with the reason the screen will say", async () => {
  const input = deployInput("wrong_webhook_id_setting", BUNDLE, "all_401");
  const reasonFor = (category: Category, cites: string[]): string => {
    if (category === "NOT_IN_DIFF") return "model_abstained";
    if (!consistentWith("all_401", category)) return "inconsistent_with_symptom"; // C2 comes first
    if (cites.length === 0) return "no_citation";
    return cites.includes("L9") ? "unknown_id" : "comment_line"; // L1 and L2 are the two reworded comment lines
  };
  let runs = 0;
  for (const category of CATEGORIES) {
    for (const lineIds of CITATIONS) {
      const model = answering({ category, file: "handlers/tidy.ts", lineIds, hunkId: "H1" });
      const r = await diagnose(input, { mode: "live", model: model as never, gate: openGate(), log: () => undefined });
      assert.equal(r.status, "not_proven", `${category} [${lineIds}]`);
      assert.equal(r.status === "not_proven" && r.reason, reasonFor(category, lineIds), `${category} [${lineIds}]`);
      runs++;
    }
  }
  assert.equal(runs, CATEGORIES.length * CITATIONS.length);
});

test("the same holds on every other symptom class (the setting bug is recorded for all_401, but a screen may meet it with another)", async () => {
  for (const symptom of SYMPTOM_CLASSES as readonly SymptomClass[]) {
    const input = deployInput("wrong_webhook_id_setting", BUNDLE, symptom);
    for (const category of CATEGORIES) {
      const model = answering({ category, file: "handlers/tidy.ts", lineIds: ["L1", "L2"], hunkId: "H1" });
      const r = await diagnose(input, { mode: "live", model: model as never, gate: openGate(), log: () => undefined });
      assert.notEqual(r.status, "proposed", `${symptom} ${category}`);
    }
  }
});

test("the setting bug's recorded answer is found, so the shop makes no model call for it: the model found no changed line, and that is what the screen will say", async () => {
  const r = await diagnose(deployInput("wrong_webhook_id_setting", BUNDLE, "all_401"), { mode: "replay", onMiss: "none", dir: CAUSE_RECORDINGS_DIR, log: () => undefined });
  assert.equal(r.status, "not_proven", "a missing recording would be 'not_diagnosed: no_recording' (a stale one: handlers/tidy.ts or the prompt changed since it was recorded)");
  assert.equal(r.status === "not_proven" && r.reason, "model_abstained", "recorded 2026-10-20: category NOT_IN_DIFF, no file, no lines");
  assert.equal(r.status === "not_proven" && NOT_PROVEN_PHRASE[r.reason], "The AI found no changed line that explains this gap.");
});

test("the setting modes are the ones the bundle holds a diff for", () => {
  assert.deepEqual(BUNDLE.settingDiffs.map((d) => d.mode), [...SETTING_MODES]);
});
