// R21 / A21, offline: B1 is the frozen file, the harness imports the product module, the freeze and the seal checks catch what they must,
// the case folders load. No model call here, and no real sealed folder is opened: the seal check runs on a folder made for the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listCaseDirs, loadCase } from "./case.ts";
import { B1_MD5, currentFreeze, freezeProblems } from "./freeze.ts";
import { gitHead, isUnderRoot, parseSeal, uncommittedProblems, verifySeal } from "./seal.ts";
import { resolveSet, type SetDeps } from "./sets.ts";
import { score } from "./score.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

test("A21: B1 is the frozen Gate-3 baseline (md5 294eed4b40c9f97fa6f90e2a03deed14, plan 6.3) and its code is unchanged", () => {
  assert.equal(B1_MD5, "294eed4b40c9f97fa6f90e2a03deed14");
  assert.equal(createHash("md5").update(readFileSync(join(ROOT, "eval/baseline/B1.mjs"))).digest("hex"), B1_MD5);
  assert.equal(currentFreeze(ROOT).b1Md5, B1_MD5);
});

test("A21: the harness makes its verdicts with the product module and has no model path of its own", () => {
  const run = readFileSync(join(ROOT, "eval/harness/run.ts"), "utf8");
  assert.match(run, /from "\.\.\/\.\.\/lib\/cause\/cause\.ts"/);
  assert.match(run, /from "\.\.\/\.\.\/lib\/cause\/input\.ts"/);
  for (const forbidden of [/@anthropic-ai\/sdk/, /from "ai"/, /@ai-sdk\//, /fetch\(/, /generateText/, /messages\.create/]) assert.ok(!forbidden.test(run), `run.ts must not use ${forbidden}`);
  // the product's cause module is the one that talks to the model, through callLlm
  assert.match(readFileSync(join(ROOT, "lib/cause/cause.ts"), "utf8"), /callLlm\(req, CauseOutput/);
});

test("A21: the freeze names the prompt version, the model id, every call parameter and the product files, and notices a change in any of them", () => {
  const now = currentFreeze(ROOT);
  assert.equal(now.modelId, "claude-sonnet-5-5");
  assert.equal(now.llmParams.maxOutputTokens.cause, 2000);
  assert.equal(now.llmParams.timeoutMs, 30_000);
  assert.equal(now.llmParams.maxRetries, 0);
  assert.ok(Object.keys(now.productSources).includes("lib/cause/cause.ts") && Object.keys(now.productSources).includes("lib/core/llm.ts") && Object.keys(now.productSources).includes("lib/cause/prompt.ts"));
  assert.deepEqual(freezeProblems(now, now), []);
  const edited = (patch: Partial<typeof now>) => freezeProblems(now, { ...now, ...patch });
  assert.equal(edited({ promptVersion: "cause-v2" }).length, 1);
  assert.equal(edited({ systemPromptSha256: "0".repeat(64) }).length, 1);
  assert.equal(edited({ modelId: "claude-other" }).length, 1);
  assert.equal(edited({ llmParams: { ...now.llmParams, timeoutMs: 31_000 } as never }).length, 1);
  assert.equal(edited({ b1Md5: "0".repeat(32) }).length, 2, "the md5 differs from the freeze and from the plan");
  assert.match(edited({ productSources: { ...now.productSources, "lib/cause/checks.ts": "x" } })[0], /lib\/cause\/checks\.ts changed since the freeze/);
});

test("A21: eval/harness/FREEZE.json matches the code as it is (after a deliberate change: npx tsx eval/harness/run.ts --freeze, and commit it BEFORE a sealed run)", () => {
  const committed = JSON.parse(readFileSync(join(ROOT, "eval/harness/FREEZE.json"), "utf8"));
  assert.deepEqual(freezeProblems(committed, currentFreeze(ROOT)), []);
});

// A synthetic sealed set, made here, in the shape SEAL.md describes (a MANIFEST.sha256 of "<sha256>  <path>" lines).
function sealedFolder() {
  const dir = mkdtempSync(join(tmpdir(), "sealed-"));
  const files: Record<string, string> = { "case1/label.json": '{"category":"NOT_IN_DIFF"}', "case1/diff.patch": "diff", "case2/label.json": "{}" };
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  const manifest = Object.entries(files).map(([p, t]) => `${sha(t)}  ${p}`).join("\n") + "\n";
  writeFileSync(join(dir, "MANIFEST.sha256"), manifest);
  return { dir, row: { set: "t", manifest: join(dir, "MANIFEST.sha256"), sha256: sha(manifest), files: 3 } };
}

test("A21: the seal check passes an untouched set and names what is wrong otherwise (changed file, extra file, edited manifest, wrong count)", () => {
  const s = sealedFolder();
  try {
    assert.deepEqual(verifySeal(s.row), { ok: true, problems: [], listed: 3 });
    writeFileSync(join(s.dir, "case1/diff.patch"), "diff, edited");
    assert.match(verifySeal(s.row).problems.join("\n"), /case1\/diff\.patch has changed since it was sealed/);
    writeFileSync(join(s.dir, "case1/diff.patch"), "diff");
    writeFileSync(join(s.dir, "case3.txt"), "new");
    assert.match(verifySeal(s.row).problems.join("\n"), /case3\.txt is not in the manifest/);
    mkdirSync(join(s.dir, "src"));
    rmSync(join(s.dir, "case3.txt"));
    writeFileSync(join(s.dir, "src/upstream.js"), "clone");
    assert.equal(verifySeal(s.row).ok, true, "src/ clones are not part of the sealed set (SEAL.md)");
    assert.equal(verifySeal({ ...s.row, files: 4 }).ok, false);
    assert.equal(verifySeal({ ...s.row, sha256: "0".repeat(64) }).ok, false);
    assert.equal(verifySeal({ ...s.row, manifest: join(s.dir, "nope/MANIFEST.sha256") }).ok, false);
  } finally {
    rmSync(s.dir, { recursive: true });
  }
});

test("SEAL.md in the repository is read as the three sealed sets and the four derived sets (2026-10-26), with 64-hex hashes and file counts (only the document is read, not the sealed folders)", () => {
  const rows = parseSeal(readFileSync(join(ROOT, "docs/planning/eval/SEAL.md"), "utf8"));
  assert.deepEqual(rows.map((r) => [r.set, r.files]), [["ha", 282], ["b2", 17], ["hb", 230], ["ha-run", 241], ["hb-nocomment-run", 66], ["hb-twin-run", 66], ["hb-original-run", 66]]);
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.sha256) && r.manifest.startsWith("~/doorbell-eval-sealed/")));
});

test("case folders: the 19 dev cases load with their class, label and both trees; a malformed folder says what is wrong", () => {
  const dirs = listCaseDirs(join(ROOT, "eval/dev"));
  assert.equal(dirs.length, 19);
  const cases = dirs.map(loadCase);
  assert.equal(cases.filter((c) => !c.label.tags.tail).length, 16, "the 16 of A21");
  const c6b = cases.find((c) => c.id === "C6b")!;
  assert.equal(c6b.symptom, "404_or_no_arrival");
  assert.equal(c6b.gate3Class, "NO_DELIVERY_404");
  assert.ok(c6b.before && c6b.before["app/api/paypal/webhook/route.ts"] && c6b.after["app/api/payments/paypal/webhook/route.ts"]);
  assert.deepEqual(cases.find((c) => c.id === "C5a")!.label.altFiles, ["deploy/env.production.keys"]);
  assert.equal(cases.find((c) => c.id === "Z")!.label.category, "NOT_IN_DIFF");

  const tmp = mkdtempSync(join(tmpdir(), "case-"));
  try {
    mkdirSync(join(tmp, "after"));
    writeFileSync(join(tmp, "diff.patch"), "");
    writeFileSync(join(tmp, "label.json"), JSON.stringify({ category: "WORK_AFTER_ACK" }));
    assert.throws(() => loadCase(tmp), /symptom\.json is missing/);
    writeFileSync(join(tmp, "symptom.json"), JSON.stringify({ class: "the shop is on fire" }));
    assert.throws(() => loadCase(tmp), /no known class/);
    writeFileSync(join(tmp, "symptom.json"), JSON.stringify({ symClass: "ACK_BUT_MISSING" }));
    assert.equal(loadCase(tmp).symptom, "2xx_but_books_unchanged");
    writeFileSync(join(tmp, "label.json"), JSON.stringify({ category: "MADE_UP" }));
    assert.throws(() => loadCase(tmp), /not one of the 8 categories/);
    writeFileSync(join(tmp, "label.json"), JSON.stringify({ truthCategory: "WORK_AFTER_ACK", truth: { file: "a.js", lines: ["run();"] } }));
    assert.deepEqual([loadCase(tmp).label.category, loadCase(tmp).label.file, loadCase(tmp).label.lines], ["WORK_AFTER_ACK", "a.js", ["run();"]]);
  } finally {
    rmSync(tmp, { recursive: true });
  }
});

test("scoring: category, pointer with the per-case leniency, and a correct abstention", () => {
  const label = { category: "RAW_BODY_ALTERED" as const, file: "src/app.js", lines: ["app.use(paypalWebhook);", "app.use(express.json());"], altFiles: [], altLines: ["const raw = await req.text();"], tags: {} };
  const shown = (category: any, file: string | null, lines: string[]) => ({ category, file, lines, abstained: false });
  assert.deepEqual(score(label, shown("RAW_BODY_ALTERED", "src/app.js", ["  app.use(paypalWebhook);"])), { cat: true, pointer: true, both: true });
  assert.deepEqual(score(label, shown("RAW_BODY_ALTERED", "src/app.js", ["const raw = await req.text();"])), { cat: true, pointer: true, both: true }, "the companion line counts");
  assert.deepEqual(score(label, shown("RAW_BODY_ALTERED", "src/other.js", ["app.use(paypalWebhook);"])), { cat: true, pointer: false, both: false });
  assert.deepEqual(score(label, shown("WRONG_WEBHOOK_ID", "src/app.js", ["app.use(paypalWebhook);"])), { cat: false, pointer: true, both: false });
  assert.deepEqual(score(label, shown(null, null, [])), { cat: false, pointer: false, both: false });
  const none = { ...label, category: "NOT_IN_DIFF" as const, file: null, lines: [] };
  assert.deepEqual(score(none, { category: null, file: null, lines: [], abstained: true }), { cat: true, pointer: true, both: true });
  assert.deepEqual(score(none, shown("APP_OR_ENV_MISMATCH", "a.js", ["x = 1;"])), { cat: false, pointer: false, both: false });
});

test("the CLI reads every dev case and builds its request with no model call (--validate)", () => {
  const out = execFileSync("npx", ["tsx", "eval/harness/run.ts", "--set", "eval/dev", "--validate"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "" } });
  assert.match(out, /19 cases read and turned into requests; no model call was made/);
});

// ---- which folder a run may read (sets.ts) -- every case below uses a folder made for the test; no real sealed folder is touched ----------

function synthetic() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "home-")));
  const sealedRoot = join(home, "doorbell-eval-sealed");
  const dir = join(sealedRoot, "ha");
  const files: Record<string, string> = { "case1/label.json": '{"category":"NOT_IN_DIFF"}', "case1/diff.patch": "diff" };
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  const manifest = Object.entries(files).map(([p, t]) => `${sha(t)}  ${p}`).join("\n") + "\n";
  writeFileSync(join(dir, "MANIFEST.sha256"), manifest);
  const b2 = join(sealedRoot, "b2");
  mkdirSync(b2, { recursive: true });
  writeFileSync(join(b2, "b2.mjs"), "export const baselineCause = () => ({});");
  const b2Manifest = `${sha("export const baselineCause = () => ({});")}  b2.mjs\n`;
  writeFileSync(join(b2, "MANIFEST.sha256"), b2Manifest);
  const rows = [
    { set: "ha", manifest: "~/doorbell-eval-sealed/ha/MANIFEST.sha256", sha256: sha(manifest), files: 2 },
    { set: "b2", manifest: "~/doorbell-eval-sealed/b2/MANIFEST.sha256", sha256: sha(b2Manifest), files: 1 },
  ];
  const deps = (over: Partial<SetDeps> = {}): SetDeps => ({ sealedRoot, home, sealRows: () => rows, freezeProblems: () => [], uncommittedProblems: () => [], ...over });
  return { home, sealedRoot, dir, b2, rows, deps, done: () => rmSync(home, { recursive: true }) };
}

test("--set may not be, or lie under, the sealed folder: a direct path, a path that does not exist yet, a symbolic link, and a relative path are all refused", () => {
  const s = synthetic();
  const outside = mkdtempSync(join(tmpdir(), "dev-"));
  try {
    symlinkSync(s.dir, join(outside, "innocent"));
    for (const bad of [s.dir, join(s.dir, "case1"), join(s.dir, "not-yet", "x"), join(outside, "innocent"), join(outside, "innocent", "case1"), s.sealedRoot]) {
      assert.throws(() => resolveSet({ set: bad }, s.deps()), /points into the sealed folder/, bad);
    }
    assert.deepEqual(resolveSet({ set: outside }, s.deps()), { setDir: outside, sealed: false });
    assert.throws(() => resolveSet({ set: outside, b2: join(s.b2, "b2.mjs") }, s.deps()), /--b2 points into the sealed folder/);
    assert.throws(() => resolveSet({ set: outside, sub: "x" }, s.deps()), /--sub belongs to --sealed/);
    assert.equal(isUnderRoot(join(s.sealedRoot, "..", "elsewhere"), s.sealedRoot), false);
    assert.equal(isUnderRoot(`${s.sealedRoot}-copy`, s.sealedRoot), false, "a sibling whose name starts the same is not under it");
    if (process.platform === "darwin") {
      const shouted = join(dirname(s.sealedRoot), "Doorbell-Eval-Sealed", "ha");
      assert.throws(() => resolveSet({ set: shouted }, s.deps()), /points into the sealed folder/, "the file system ignores case, so the check does too");
    }
    const linkedRoot = join(outside, "sealed-link");
    symlinkSync(s.sealedRoot, linkedRoot);
    assert.equal(isUnderRoot(join(s.dir, "case1"), linkedRoot), true, "a sealed root that is itself a link still guards what it points to");
  } finally {
    s.done();
    rmSync(outside, { recursive: true });
  }
});

test("--set together with --sealed is refused (one folder would be verified and another run), and neither flag is refused too", () => {
  const s = synthetic();
  try {
    assert.throws(() => resolveSet({ set: "eval/dev", sealed: "ha" }, s.deps()), /cannot be combined/);
    assert.throws(() => resolveSet({}, s.deps()), /give --set/);
  } finally {
    s.done();
  }
});

test("--sealed (and so --validate on a sealed set) checks the freeze, the committed files and the seal hashes before it returns a folder", () => {
  const s = synthetic();
  try {
    const logs: string[] = [];
    const ok = resolveSet({ sealed: "ha" }, s.deps({ log: (l) => void logs.push(l) }));
    assert.deepEqual(ok, { setDir: s.dir, sealed: true });
    assert.match(logs.join("\n"), /seal ok for ha: 2 files match/);

    assert.throws(() => resolveSet({ sealed: "ha" }, s.deps({ freezeProblems: () => ["prompt changed"] })), /the freeze does not hold:\s+prompt changed/);
    assert.throws(() => resolveSet({ sealed: "ha" }, s.deps({ uncommittedProblems: () => ["eval/harness/FREEZE.json is not in the last commit"] })), /not the committed ones/);
    assert.throws(() => resolveSet({ sealed: "nope" }, s.deps()), /no set named nope/);

    writeFileSync(join(s.dir, "case1/diff.patch"), "diff, edited after sealing");
    assert.throws(() => resolveSet({ sealed: "ha" }, s.deps()), /the seal does not hold:[\s\S]*case1\/diff\.patch has changed since it was sealed/);
    writeFileSync(join(s.dir, "case1/diff.patch"), "diff");

    // --sub: a subfolder inside the set is fine (under src/, which SEAL.md says is not part of the sealed set), leaving the set is not
    mkdirSync(join(s.dir, "src", "variant"), { recursive: true });
    writeFileSync(join(s.dir, "src", "variant", "x.txt"), "x");
    assert.equal(resolveSet({ sealed: "ha", sub: "src/variant" }, s.deps()).setDir, join(s.dir, "src", "variant"));
    assert.throws(() => resolveSet({ sealed: "ha", sub: ".." }, s.deps()), /--sub leaves the sealed set/);
    assert.throws(() => resolveSet({ sealed: "ha", sub: "../b2" }, s.deps()), /--sub leaves the sealed set/);
  } finally {
    s.done();
  }
});

test("a --b2 module is imported code: it is accepted only from the b2 set that passed its own seal check", () => {
  const s = synthetic();
  try {
    const b2 = join(s.b2, "b2.mjs");
    assert.throws(() => resolveSet({ sealed: "ha", b2 }, s.deps()), /not inside the checked b2 set/);
    assert.deepEqual(resolveSet({ sealed: "ha,b2", b2 }, s.deps()), { setDir: s.dir, b2, sealed: true });
    assert.throws(() => resolveSet({ sealed: "ha,b2", b2: join(s.home, "elsewhere.mjs") }, s.deps()), /not inside the checked b2 set/);
    assert.throws(() => resolveSet({ sealed: "b2" }, s.deps()), /name the set of cases too/);
    writeFileSync(b2, "export const baselineCause = () => ({ evil: true });");
    assert.throws(() => resolveSet({ sealed: "ha,b2", b2 }, s.deps()), /the seal does not hold/);
  } finally {
    s.done();
  }
});

test("the CLI itself: with HOME pointing at a synthetic folder, --set into its sealed folder is refused before anything is read, --validate included", () => {
  const s = synthetic();
  const run = (args: string[]) => {
    try {
      execFileSync("npx", ["tsx", "eval/harness/run.ts", ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: s.home, ANTHROPIC_API_KEY: "" } });
      return "ran";
    } catch (e) {
      return String((e as { stderr?: string }).stderr);
    }
  };
  try {
    assert.match(run(["--set", s.dir, "--validate"]), /points into the sealed folder/);
    assert.match(run(["--set", s.dir]), /points into the sealed folder/);
    assert.match(run(["--set", "eval/dev", "--sealed", "ha", "--validate"]), /cannot be combined/);
    // a sealed run needs the freeze to hold and FREEZE.json and SEAL.md to be the committed ones; it refuses before it opens any set
    assert.match(run(["--sealed", "ha", "--validate"]), /refusing to run a sealed set/);
  } finally {
    s.done();
  }
});

test("uncommittedProblems: missing, untracked and modified files are problems, identical ones are not; the git reader says 'not committed' for a path HEAD does not have", () => {
  const files = ["a.json", "b.md"];
  const work: Record<string, Buffer | null> = { "a.json": Buffer.from("1"), "b.md": Buffer.from("2") };
  const head: Record<string, Buffer | null> = { "a.json": Buffer.from("1"), "b.md": Buffer.from("2") };
  const check = () => uncommittedProblems(files, (r) => work[r] ?? null, (r) => head[r] ?? null);
  assert.deepEqual(check(), []);
  work["b.md"] = Buffer.from("2 edited");
  assert.match(check().join("\n"), /b\.md differs from the last commit/);
  head["a.json"] = null;
  assert.match(check().join("\n"), /a\.json is not in the last commit \(untracked/);
  work["a.json"] = null;
  assert.match(check().join("\n"), /a\.json does not exist in the working tree/);
  assert.equal(gitHead(ROOT)("eval/harness/this-file-does-not-exist.json"), null);
});

test("the freeze also covers the harness files that decide a run and the installed versions of the SDK and the provider", () => {
  const now = currentFreeze(ROOT);
  for (const f of ["eval/harness/run.ts", "eval/harness/score.ts", "eval/harness/case.ts", "eval/harness/seal.ts", "eval/harness/sets.ts", "eval/harness/freeze.ts"]) assert.ok(now.productSources[f], f);
  assert.deepEqual(Object.keys(now.packages).sort(), ["@ai-sdk/anthropic", "ai"]);
  assert.match(now.packages.ai, /^\d+\.\d+\.\d+/);
  assert.match(freezeProblems(now, { ...now, packages: { ...now.packages, ai: "0.0.1" } })[0], /package ai: frozen \d+\.\d+\.\d+.*, installed 0\.0\.1/);
  assert.match(freezeProblems(now, { ...now, productSources: { ...now.productSources, "eval/harness/score.ts": "x" } })[0], /eval\/harness\/score\.ts changed since the freeze/);
});

test("the harness re-runs only transport failures: network, timeout, 429 and 5xx; an unreadable or empty answer is a result", () => {
  const src = readFileSync(join(ROOT, "eval/harness/run.ts"), "utf8");
  const list = /const INFRA = new Set\(\[([^\]]*)\]\)/.exec(src)![1].replace(/["\s]/g, "").split(",").sort();
  assert.deepEqual(list, ["network", "rate_limited", "timeout", "upstream_error"]);
  assert.ok(!list.includes("bad_json") && !list.includes("empty") && !list.includes("error"));
});
