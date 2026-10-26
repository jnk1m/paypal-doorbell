// The diff as data: ids, citable lines, and the A11-style agreement between a line id and the file it names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCase, listCaseDirs } from "../../eval/harness/case.ts";
import { computeDiffs } from "../shop/diffs.ts";
import { allLines, diffFromShop, indexById, parseUnifiedDiff, renderDiff } from "./diff.ts";
import { normalizeSource } from "./hygiene.ts";
import { prepareInput, shopInput } from "./input.ts";
import { ROOT } from "./test-helpers.ts";

test("only changed lines have ids, ids run L1.. in order, hunks H1..; renames add two lines that can be cited", () => {
  const c = loadCase(join(ROOT, "eval/dev/C6b"));
  const { input } = prepareInput({ diff: c.diff, before: c.before, after: c.after, symptom: c.symptom });
  const ids = allLines(input.diff).filter((l) => l.id).map((l) => l.id);
  assert.deepEqual(ids, ["L1", "L2", "L3", "L4", "L5", "L6"]);
  assert.deepEqual(input.diff.files.map((f) => f.hunks.map((h) => h.id)), [["H1"], ["H2"]]);
  const index = indexById(input.diff);
  assert.equal(index.get("L1")!.text, "rename from app/api/paypal/webhook/route.ts");
  assert.equal(index.get("L2")!.text, "rename to app/api/payments/paypal/webhook/route.ts");
  assert.ok(allLines(input.diff).filter((l) => l.kind === "ctx").every((l) => l.id === undefined && !l.citable));
  assert.match(renderDiff(input.diff), /^FILE app\/api\/payments\/paypal\/webhook\/route\.ts \(renamed from app\/api\/paypal\/webhook\/route\.ts\)\nL1 {4}R rename from /);
});

test("every added or context line of every dev case is the text of the after file at that line number; removed lines match the before file (100%)", () => {
  let checked = 0;
  for (const dir of listCaseDirs(join(ROOT, "eval/dev"))) {
    const c = loadCase(dir);
    const { input } = prepareInput({ diff: c.diff, before: c.before, after: c.after, symptom: c.symptom });
    for (const f of input.diff.files) {
      const after = f.status === "deleted" ? undefined : readFileSync(join(dir, "after", f.path), "utf8").split("\n");
      const before = f.status === "added" ? undefined : readFileSync(join(dir, "before", f.oldPath), "utf8").split("\n");
      for (const l of f.hunks.flatMap((h) => h.lines)) {
        const source = l.kind === "del" ? before : after;
        assert.equal(source?.[l.no! - 1], l.text, `${c.id} ${f.path} ${l.kind} line ${l.no}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 300, `only ${checked} lines were checked`);
});

test("the planted change of each dev case is among its citable lines, comments, blanks and string-only lines are not", () => {
  const c = loadCase(join(ROOT, "eval/dev/C1a"));
  const { input } = prepareInput({ diff: c.diff, before: c.before, after: c.after, symptom: c.symptom });
  const lines = allLines(input.diff).filter((l) => l.id);
  // (a reordering leaves one of the two lines as unchanged context, so the label names two and one of them is enough)
  assert.ok(c.label.lines.some((truth) => lines.some((l) => l.citable && l.text.trim() === truth)), "a labelled cause line is citable");
  // the removed comment above "app.use(paypalWebhook)" is a changed line and not citable
  const comment = lines.find((l) => l.text.includes("needs the untouched request bytes"));
  assert.ok(comment && !comment.citable && comment.whyNot === "comment");
});

test("the shop's own diff goes through the same shape: ids resolve to lines of the handler files", () => {
  const bundle = computeDiffs(ROOT);
  for (const d of bundle.diffs) {
    const input = shopInput(d.mode, bundle, "all_401");
    const lines = allLines(input.diff).filter((l) => l.id);
    assert.ok(lines.length >= 3, d.mode);
    const text = (path: string) => readFileSync(join(ROOT, path), "utf8").split("\n");
    for (const l of lines) assert.equal(text(l.kind === "del" ? d.from : d.to)[l.no! - 1], l.text, `${d.mode} ${l.id}`);
    assert.equal(input.files.length, 1);
    assert.equal(input.files[0].path, d.to);
  }
  const bad = shopInput("bad_body", bundle, "all_401");
  const citable = allLines(bad.diff).filter((l) => l.citable).map((l) => l.text.trim());
  assert.ok(citable.includes("const event = canonical(JSON.parse(ctx.rawBody));"));
  assert.ok(!citable.some((t) => t.startsWith("//")));
});

test("a plain `diff -u` (no git header) and a deleted file are read too", () => {
  const plain = ["--- a/x.js\t2026-01-01", "+++ b/x.js\t2026-01-02", "@@ -1,2 +1,2 @@", " a();", "-b();", "+c();", "--- a/y.js", "+++ /dev/null", "@@ -1 +0,0 @@", "-gone();", ""].join("\n");
  const d = parseUnifiedDiff(plain);
  assert.deepEqual(d.files.map((f) => [f.path, f.status]), [["x.js", "modified"], ["y.js", "deleted"]]);
  assert.deepEqual(allLines(d).filter((l) => l.id).map((l) => [l.id, l.kind, l.text]), [["L1", "del", "b();"], ["L2", "add", "c();"], ["L3", "del", "gone();"]]);
});

test("a removed line whose text starts with '-- ' inside a hunk is a removed line, not the next file's header", () => {
  const diff = ["diff --git a/q.sql b/q.sql", "--- a/q.sql", "+++ b/q.sql", "@@ -1,2 +1,1 @@", "--- old comment", " SELECT 1;", ""].join("\n");
  const d = parseUnifiedDiff(diff);
  assert.equal(d.files.length, 1);
  assert.deepEqual(allLines(d).map((l) => [l.kind, l.text]), [["del", "-- old comment"], ["ctx", "SELECT 1;"]]);
});

test("shop text is normalized like everything else (the diff lines and the file text are one text)", () => {
  const bundle = computeDiffs(ROOT);
  const input = shopInput("ack_then_drop", bundle, "2xx_but_books_unchanged");
  for (const f of input.files) assert.equal(normalizeSource(f.text).text, f.text);
  assert.equal(diffFromShop(bundle.diffs[0]).files[0].hunks[0].id, "H1");
});

test("a removed line is shown with the OLD file (its number counts there); C1' keeps comparing the diff file's own path", () => {
  const bundle = computeDiffs(ROOT);
  const ack = shopInput("ack_then_drop", bundle, "2xx_but_books_unchanged");
  const lines = allLines(ack.diff).filter((l) => l.id);
  const removed = lines.filter((l) => l.kind === "del");
  const added = lines.filter((l) => l.kind === "add");
  assert.ok(removed.length > 0 && added.length > 0);
  for (const l of removed) assert.deepEqual([l.file, l.shownFile], ["handlers/ack-drop.ts", "handlers/good.ts"], l.id);
  for (const l of added) assert.deepEqual([l.file, l.shownFile], ["handlers/ack-drop.ts", "handlers/ack-drop.ts"], l.id);
  // the file that is shown has that many lines: no "ack-drop.ts:18" for a 15-line file
  const good = readFileSync(join(ROOT, "handlers/good.ts"), "utf8").split("\n").length;
  const bad = readFileSync(join(ROOT, "handlers/ack-drop.ts"), "utf8").split("\n").length;
  assert.ok(Math.max(...removed.map((l) => l.no!)) <= good && Math.max(...added.map((l) => l.no!)) <= bad);

  // a generic diff with a rename: removed lines belong to the old path
  const c = loadCase(join(ROOT, "eval/dev/C6b"));
  const { input } = prepareInput({ diff: c.diff, before: c.before, after: c.after, symptom: c.symptom });
  const del = allLines(input.diff).find((l) => l.kind === "del" && l.file === "app/api/payments/paypal/webhook/route.ts")!;
  assert.equal(del.shownFile, "app/api/paypal/webhook/route.ts");
  const rename = allLines(input.diff).find((l) => l.kind === "rename")!;
  assert.equal(rename.shownFile, rename.file);
});
