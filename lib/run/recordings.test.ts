// The recordings are found in a deployed function: the product names their folder itself (lib/run/recordings.ts) instead of relying on the
// default of the frozen lib/core/llm.ts, which comes from import.meta.url. This test is the guard that every call site does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "../cause/test-helpers.ts";
import { RECORDINGS_DIR } from "../core/llm.ts";
import { CAUSE_RECORDINGS_DIR } from "./recordings.ts";

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

test("the product's recordings folder is the project's fixtures/recordings, with the three recorded causes in it", () => {
  assert.equal(CAUSE_RECORDINGS_DIR, join(ROOT, "fixtures/recordings/"), "tests run from the project root, as `npm test` does");
  assert.equal(CAUSE_RECORDINGS_DIR, RECORDINGS_DIR, "on a developer's machine it is also what llm.ts derives");
  assert.equal(readdirSync(CAUSE_RECORDINGS_DIR).filter((f) => f.endsWith(".json")).length >= 3, true);
  assert.ok(existsSync(CAUSE_RECORDINGS_DIR));
});

test("every product call of diagnose() (app/ and lib/, except lib/cause itself) passes the folder, so a deployed function never falls back on import.meta.url", () => {
  const files = [...sources(join(ROOT, "app")), ...sources(join(ROOT, "lib"))].filter((f) => !relative(join(ROOT, "lib"), f).startsWith("cause/"));
  let calls = 0;
  const missing: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8").replace(/\/\/.*$/gm, ""); // comments are not calls
    for (const m of text.matchAll(/\bdiagnose(?:Many)?\(/g)) {
      calls++;
      const around = text.slice(m.index!, m.index! + 400);
      if (!/dir:\s*[^,}]*(CAUSE_RECORDINGS_DIR|causeDir)/.test(around)) missing.push(`${relative(ROOT, f)} @${m.index}`);
    }
  }
  assert.ok(calls >= 2, `the product calls diagnose (${calls} calls found)`);
  assert.deepEqual(missing, []);
});
