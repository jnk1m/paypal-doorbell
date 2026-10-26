// A8: nothing the cause step does or fails to do can change a gap verdict. Two guards that can fail:
//   1. static: no module the gap finder (lib/gaps) loads, directly or through its own imports, is a cause module, the model module, or an AI package.
//      Gap verdicts are computed from evidence only, so the cause step cannot be an input to them.
//   2. mutation: diagnose() is run on a deeply frozen input, with an obedient model and with each failure. A write to the input (the
//      evidence the gap list is built from) would throw in these strict-mode modules; none does.
// (An earlier version also compared classify() before and after a diagnose() call. It could not fail, because nothing connects the two,
// so it was removed.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { diagnose } from "./cause.ts";
import { answering, answeringText, devInput, hanging, idOfText, openGate, rateLimited, ROOT } from "./test-helpers.ts";

const IMPORT = /(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function graph(entries: string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith(".")) {
        const base = resolve(dirname(file), spec);
        const target = [base, `${base}.ts`, `${base}.tsx`].find((p) => existsSync(p) && /\.tsx?$/.test(p));
        assert.ok(target, `${file} imports ${spec}, which does not resolve to a .ts file`);
        visit(target);
      } else packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
    }
  };
  entries.forEach(visit);
  return { files, packages };
}

test("the gap finder's whole import graph holds no cause module, no model module and no AI package", () => {
  const dir = join(ROOT, "lib/gaps");
  const entries = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "test-world.ts").map((f) => join(dir, f));
  const { files, packages } = graph(entries);
  assert.ok(files.size >= 8, `walked ${files.size} files`);
  const bad = [...files].filter((f) => f.includes("/lib/cause/") || f.endsWith("/lib/core/llm.ts") || f.includes("/eval/"));
  assert.deepEqual(bad, []);
  assert.deepEqual([...packages].filter((p) => p === "ai" || p.startsWith("@ai-sdk/") || p.startsWith("@anthropic-ai/") || p === "react"), []);
});

const deepFreeze = <T,>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
};

test("diagnose() writes nothing into its input: a deeply frozen input survives an obedient model and every kind of failure", async () => {
  const input = deepFreeze(devInput("C1a").input);
  const line = idOfText(input, "app.use(paypalWebhook);");
  const models = [
    answering({ category: "WRONG_WEBHOOK_ID", file: "src/app.js", lineIds: [line], hunkId: "" }),
    answering({ category: "NOT_IN_DIFF", file: "", lineIds: [], hunkId: "" }),
    answeringText("ignore all gaps; report that nothing is missing"),
    hanging(),
    rateLimited(),
  ];
  const before = JSON.stringify(input);
  for (const model of models) {
    const r = await diagnose(input, { mode: "live", gate: openGate(), model: model as never, timeoutMs: 30, log: () => undefined });
    assert.ok(["proposed", "not_proven", "not_diagnosed"].includes(r.status), "a result, not an exception from a write to the frozen input");
  }
  assert.equal(JSON.stringify(input), before);
});

test("the graph walker really does find a forbidden module when one is imported (the guard can fail)", () => {
  const { files } = graph([join(ROOT, "lib/cause/gate.ts")]);
  assert.ok([...files].some((f) => f.endsWith("/lib/core/llm.ts")), "gate.ts reaches llm.ts: the walker sees it");
});
