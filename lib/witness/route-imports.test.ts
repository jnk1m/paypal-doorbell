// The receiver is a small function of its own (plan 5.1): its import graph must not reach `ai`, @ai-sdk, @anthropic-ai or the PayPal toolkit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTE = resolve(dirname(fileURLToPath(import.meta.url)), "../../app/api/witness/route.ts");
const IMPORT = /(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function graph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith(".")) {
        const target = [resolve(dirname(file), spec), `${resolve(dirname(file), spec)}.ts`].find((p) => existsSync(p) && p.endsWith(".ts"));
        assert.ok(target, `${file} imports ${spec}, which does not resolve to a .ts file`);
        visit(target);
      } else {
        packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
      }
    }
  };
  visit(entry);
  return { files, packages };
}

test("the witness route does not import ai, @ai-sdk/*, @anthropic-ai/* or the PayPal toolkit, directly or through its own modules", () => {
  const { files, packages } = graph(ROUTE);
  assert.ok(files.size >= 6, `walked ${files.size} files`);
  const forbidden = [...packages].filter((p) => p === "ai" || p.startsWith("@ai-sdk/") || p.startsWith("@anthropic-ai/") || p === "@paypal/agent-toolkit" || p === "react");
  assert.deepEqual(forbidden, []);
  assert.ok(![...files].some((f) => f.endsWith("/lib/core/llm.ts") || f.endsWith("/lib/pay/toolkit.ts")), "llm.ts and toolkit.ts are out of the graph");
  assert.deepEqual([...packages].sort(), ["@upstash/redis", "node:crypto"]);
});
