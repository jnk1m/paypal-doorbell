// b2-run.ts: the command-line baseline is spawned on a case folder, its line numbers become text, the frozen scorer judges it, and the
// rows merge into a copy of run.ts's results without touching anything else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCaseDirs, loadCase } from "./case.ts";
import { mergeB2, runB2 } from "./b2-run.ts";

const DIFF = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1,3 +1,3 @@
 const x = 1;
-    await applyEvent(event);
+    res.sendStatus(200);
 done();
`;

function makeCase(dir: string, category = "WORK_AFTER_ACK") {
  mkdirSync(join(dir, "before", "src"), { recursive: true });
  mkdirSync(join(dir, "after", "src"), { recursive: true });
  writeFileSync(join(dir, "before", "src", "app.js"), "const x = 1;\n    await applyEvent(event);\ndone();\n");
  writeFileSync(join(dir, "after", "src", "app.js"), "const x = 1;\n    res.sendStatus(200);\ndone();\n");
  writeFileSync(join(dir, "diff.patch"), DIFF);
  writeFileSync(join(dir, "symptom.json"), JSON.stringify({ class: "2xx_but_books_unchanged", symptom: "2xx_but_books_unchanged" }));
  writeFileSync(join(dir, "label.json"), JSON.stringify({ category, file: "src/app.js", lines: category === "NOT_IN_DIFF" ? [] : ["res.sendStatus(200);"], altLines: category === "NOT_IN_DIFF" ? [] : ["await applyEvent(event);"] }));
}

// A stand-in for b2.mjs: reads symptom.json's "symptom" key like the sealed program does, answers from an env var, cites line numbers.
const FAKE = `
import fs from "node:fs";
import path from "node:path";
const dir = process.argv[2];
if (!dir) { console.error("usage"); process.exit(2); }
const s = JSON.parse(fs.readFileSync(path.join(dir, "symptom.json"), "utf8"));
if (s.symptom !== "2xx_but_books_unchanged") { console.error("b2: wrong key"); process.exit(2); }
const mode = process.env.FAKE_B2 ?? "right";
console.log("some chatter first");
if (mode === "right") console.log(JSON.stringify({ category: "WORK_AFTER_ACK", file: "src/app.js", lines: [2], lines_before: [], rule: "ack_first", why: "x" }));
else if (mode === "before") console.log(JSON.stringify({ category: "WORK_AFTER_ACK", file: "src/app.js", lines: [], lines_before: [2], rule: "r" }));
else if (mode === "wrong") console.log(JSON.stringify({ category: "EVENT_TYPE_DROPPED", file: "src/app.js", lines: [2], lines_before: [], rule: "r" }));
else if (mode === "abstain") console.log(JSON.stringify({ category: "NOT_IN_DIFF", file: null, lines: [], lines_before: [], rule: "none" }));
else if (mode === "crash") { console.error("b2: boom"); process.exit(2); }
else console.log("not json");
`;

function withEnv<T>(k: string, v: string, f: () => T): T {
  const old = process.env[k];
  process.env[k] = v;
  try {
    return f();
  } finally {
    if (old === undefined) delete process.env[k];
    else process.env[k] = old;
  }
}

test("runB2: the program is spawned on the case folder, its numbers become text, the scorer judges category and pointer", () => {
  const tmp = mkdtempSync(join(tmpdir(), "b2run-"));
  try {
    makeCase(join(tmp, "set", "c1"));
    const fake = join(tmp, "fake-b2.mjs");
    writeFileSync(fake, FAKE);
    chmodSync(fake, 0o755);
    const cases = listCaseDirs(join(tmp, "set")).map(loadCase);
    const right = withEnv("FAKE_B2", "right", () => runB2(cases, fake))[0];
    assert.equal(right.category, "WORK_AFTER_ACK");
    assert.deepEqual(right.lines, ["    res.sendStatus(200);"]);
    assert.deepEqual(right.score, { cat: true, pointer: true, both: true });
    assert.equal(right.rule, "ack_first");
    const before = withEnv("FAKE_B2", "before", () => runB2(cases, fake))[0];
    assert.deepEqual(before.lines, ["    await applyEvent(event);"], "lines_before are read from the before tree");
    assert.equal(before.score.pointer, true, "the other half of the modified line is accepted by the scorer");
    const wrong = withEnv("FAKE_B2", "wrong", () => runB2(cases, fake))[0];
    assert.deepEqual(wrong.score, { cat: false, pointer: true, both: false });
    const abstain = withEnv("FAKE_B2", "abstain", () => runB2(cases, fake))[0];
    assert.deepEqual(abstain.score, { cat: false, pointer: false, both: false });
    const crash = withEnv("FAKE_B2", "crash", () => runB2(cases, fake))[0];
    assert.match(crash.error ?? "", /exit 2: b2: boom/);
    assert.deepEqual(crash.score, { cat: false, pointer: false, both: false });
    const junk = withEnv("FAKE_B2", "junk", () => runB2(cases, fake))[0];
    assert.match(junk.error ?? "", /no JSON line/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runB2: an abstention is right on a NOT_IN_DIFF case", () => {
  const tmp = mkdtempSync(join(tmpdir(), "b2run-"));
  try {
    makeCase(join(tmp, "set", "z"), "NOT_IN_DIFF");
    const fake = join(tmp, "fake-b2.mjs");
    writeFileSync(fake, FAKE);
    const row = withEnv("FAKE_B2", "abstain", () => runB2(listCaseDirs(join(tmp, "set")).map(loadCase), fake))[0];
    assert.deepEqual(row.score, { cat: true, pointer: true, both: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mergeB2: a copy with perCase[].B2 and summary.B2; the case sets must match; the original rows are kept as they were", () => {
  const results = { sealed: true, summary: { cases: 2, runsPerCase: 1 }, perCase: [
    { case: "a", label: "WORK_AFTER_ACK", tags: {}, runs: [{ run: 0, status: "proposed", cat: true, pointer: true, both: true }], B1: { category: "X", score: { cat: false, pointer: false, both: false } } },
    { case: "b", label: "NOT_IN_DIFF", tags: {}, runs: [{ run: 0, status: "not_proven", cat: true, pointer: true, both: true }], B1: { category: "NOT_IN_DIFF", score: { cat: true, pointer: true, both: true } } },
  ] };
  const rows = [
    { case: "a", label: "WORK_AFTER_ACK", category: "WORK_AFTER_ACK", file: "src/app.js", evidence_line: "res.sendStatus(200);", lines: ["res.sendStatus(200);"], rule: "r", ms: 1, score: { cat: true, pointer: true, both: true } },
    { case: "b", label: "NOT_IN_DIFF", category: "OTHER_CODE_CHANGE", file: "x", evidence_line: "y", lines: ["y"], ms: 1, score: { cat: false, pointer: false, both: false } },
  ];
  const merged = mergeB2(results, rows, { module: "~/b2/b2.mjs", sha256: "ab" });
  assert.deepEqual(merged.perCase[0].B2, { category: "WORK_AFTER_ACK", file: "src/app.js", evidence_line: "res.sendStatus(200);", rule: "r", score: { cat: true, pointer: true, both: true } });
  assert.deepEqual(merged.perCase[0].B1, results.perCase[0].B1);
  assert.deepEqual(merged.perCase[0].runs, results.perCase[0].runs);
  assert.deepEqual(merged.summary, { cases: 2, runsPerCase: 1, B2: { category: 1, both: 1 } });
  assert.deepEqual(merged.b2, { module: "~/b2/b2.mjs", sha256: "ab" });
  assert.equal((results.perCase[0] as Record<string, unknown>).B2, undefined, "the input is not mutated");
  assert.throws(() => mergeB2(results, rows.slice(0, 1), { module: "m", sha256: "s" }), /B2 lacks b/);
  assert.throws(() => mergeB2({ perCase: results.perCase.slice(0, 1) }, rows, { module: "m", sha256: "s" }), /results lack b/);
});
