// What a deployed function can do with "prove the fix": read recorded JSON, and nothing else. The lookup serves a proven patch only after the
// owner has read it; the import graph of everything a function loads from lib/fix holds no model call, no compiler, no child process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { recordedFix, type FixStore } from "./recorded.ts";
import { ROOT, provenFix } from "./test-helpers.ts";

const HASH = "c".repeat(64);

async function store(): Promise<{ s: FixStore; sha: string }> {
  const { result } = await provenFix("ack_then_drop", HASH);
  return { s: { results: { ack_then_drop: result }, reviewed: {} }, sha: result.patchSha256 };
}

test("a proven patch nobody has reviewed is not served", async () => {
  const { s } = await store();
  assert.equal(recordedFix("ack_then_drop", HASH, s), null);
  assert.equal(recordedFix("ack_then_drop", HASH, { ...s, reviewed: { ack_then_drop: "0".repeat(64) } }), null, "the approval is of another file");
});

test("a reviewed patch is served, labelled recorded, for the cause it answers and no other", async () => {
  const { s, sha } = await store();
  const reviewed: FixStore = { ...s, reviewed: { ack_then_drop: sha } };
  const got = recordedFix("ack_then_drop", HASH, reviewed)!;
  assert.equal(got.basis, "recorded");
  assert.equal(got.verdict, "proven");
  assert.equal(s.results.ack_then_drop!.basis, "replayed", "the stored result is not changed by serving it");
  assert.equal(recordedFix("ack_then_drop", "d".repeat(64), reviewed), null, "the diff or the cause recording changed since: another cause");
  assert.equal(recordedFix("bad_body", HASH, reviewed), null, "no record for that mode");
});

test("a fix that was not proven carries no code, so it is served without a review", async () => {
  const { s } = await store();
  const r = s.results.ack_then_drop!;
  const notProven = { ...r, verdict: "not_proven" as const, patch: null, baseline: null };
  assert.equal(recordedFix("ack_then_drop", HASH, { results: { ack_then_drop: notProven }, reviewed: {} })?.verdict, "not_proven");
});

// ---- the import graph ----------------------------------------------------------------------------------------------------------------------

const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
const TYPE_ONLY = /^\s*import\s+type\s[^;]*?from\s+["'][^"']+["'];?\s*$/gm; // erased when the file is compiled: it loads nothing
const importsOf = (source: string): string[] => [...source.replace(TYPE_ONLY, "").matchAll(IMPORT)].map((m) => m[1]);

// Every module reachable from `entry` through its imports: relative files (followed) and bare/node: specifiers (listed).
function graph(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const walk = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      if (/^(\.|\.\.)\//.test(spec)) {
        const target = resolve(dirname(file), spec);
        if (target.endsWith(".ts") && existsSync(target)) walk(target);
      } else bare.add(spec);
    }
  };
  walk(entry);
  return { files, bare };
}

const rel = (files: Set<string>) => [...files].map((f) => f.slice(ROOT.length + 1)).sort();
const HEAVY_BARE = ["typescript", "node:child_process", "child_process", "node:worker_threads", "ai", "@ai-sdk/anthropic", "node:vm"];

test("what a deployed function loads from lib/fix: the lookup, the rules and the types, no compiler, no child process, no model SDK", () => {
  for (const entry of ["lib/fix/recorded.ts", "lib/fix/rules.ts", "lib/fix/types.ts"]) {
    const g = graph(join(ROOT, entry));
    assert.deepEqual([...g.bare].filter((b) => HEAVY_BARE.includes(b)), [], `${entry} reaches ${[...g.bare].join(", ")}`);
    const fixFiles = rel(g.files).filter((f) => f.startsWith("lib/fix/"));
    assert.deepEqual(fixFiles.filter((f) => !["lib/fix/recorded.ts", "lib/fix/rules.ts", "lib/fix/types.ts"].includes(f)), [], `${entry} reaches ${fixFiles.join(", ")}`);
  }
});

test("the live snapshot (lib/run/build.ts) loads only recorded.ts of lib/fix (types are erased), and the stack it runs never starts a process or compiles code", () => {
  const g = graph(join(ROOT, "lib/run/build.ts"));
  assert.deepEqual(rel(g.files).filter((f) => f.startsWith("lib/fix/")), ["lib/fix/recorded.ts"]);
  assert.deepEqual([...g.bare].filter((b) => ["typescript", "node:child_process", "child_process", "node:worker_threads", "node:vm"].includes(b)), []);
  const config = graph(join(ROOT, "lib/run/config.ts"));
  assert.deepEqual(rel(config.files).filter((f) => f.startsWith("lib/fix/")), [], "the wiring (config.ts) gives the snapshot no fix.prove: a deployed function never proves anything");
  assert.deepEqual([...config.bare].filter((b) => ["typescript", "node:child_process", "child_process", "node:worker_threads", "node:vm"].includes(b)), []);
});

test("nothing under app/ or in lib/ outside lib/fix loads the model wrapper, the sandbox or the compiler side of the proof", () => {
  const importers: string[] = [];
  const LOCAL_ONLY = /\/fix\/(llm|fix|prove|sandbox|referee|scenarios|files|result|check|allowlist|prompt|edits|baselines|leftovers)\.ts$/;
  const walkDir = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walkDir(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !full.includes("/lib/fix/")) {
        if (importsOf(readFileSync(full, "utf8")).some((spec) => LOCAL_ONLY.test(spec))) importers.push(full.slice(ROOT.length + 1));
      }
    }
  };
  for (const d of [join(ROOT, "lib"), join(ROOT, "app")]) walkDir(d);
  assert.deepEqual(importers, []);
});

test("the upload to Vercel leaves out the model's recorded answers and the patched files (text for the owner and for local scripts; nothing deployed reads them)", () => {
  const ignored = readFileSync(join(ROOT, ".vercelignore"), "utf8").split("\n").map((l) => l.trim());
  assert.ok(ignored.includes("fixtures/fix-recordings/"));
  assert.ok(ignored.includes("fixtures/fix/patched/"));
  assert.ok(!ignored.includes("fixtures/fix/"), "results.json and reviewed.json are what the deployed function reads");
});
