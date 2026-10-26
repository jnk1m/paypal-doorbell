// What is frozen for an evaluation run (plan 6.4, R21): the prompt version and text, the output schema, the model id, every call
// parameter, B1's md5, and the sha256 of the product source the harness imports. FREEZE.json is committed BEFORE the first model call
// of a sealed run; a run recomputes these values and refuses to start on a sealed set when any differs. Dev runs only warn.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { LLM_PARAMS, MODEL_ID } from "../../lib/core/llm.ts";
import { CauseOutput, PROMPT_VERSION, SYSTEM_PROMPT } from "../../lib/cause/prompt.ts";

export const B1_MD5 = "294eed4b40c9f97fa6f90e2a03deed14";
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");

export interface Freeze {
  promptVersion: string;
  systemPromptSha256: string;
  outputSchemaSha256: string;
  modelId: string;
  llmParams: typeof LLM_PARAMS;
  b1Md5: string;
  productSources: Record<string, string>; // sha256 of each product file the harness imports, and of the harness files themselves
  packages: Record<string, string>; // installed versions of the SDK and the provider package
}

// The product files whose behaviour decides an evaluation result: the request builder, the model call, the two checks and what they read.
// (The replay, the live gate and the card are product too, but a number from the harness does not depend on them.)
// The harness files that decide what a run does and how it is scored are frozen with them: a changed scorer or run loop is a changed result.
export const PRODUCT_FILES = [
  "lib/cause/categories.ts", "lib/cause/cause.ts", "lib/cause/checks.ts", "lib/cause/diff.ts", "lib/cause/hygiene.ts", "lib/cause/input.ts", "lib/cause/lines.ts", "lib/cause/prompt.ts", "lib/core/llm.ts",
  "eval/harness/case.ts", "eval/harness/freeze.ts", "eval/harness/run.ts", "eval/harness/score.ts", "eval/harness/seal.ts", "eval/harness/sets.ts",
];
// The SDK and the provider package decide what a call sends and how the answer is read.
export const FROZEN_PACKAGES = ["ai", "@ai-sdk/anthropic"] as const;
export const productSourceFiles = (_root: string): string[] => [...PRODUCT_FILES];

export function currentFreeze(root: string): Freeze {
  return {
    promptVersion: PROMPT_VERSION,
    systemPromptSha256: sha256(SYSTEM_PROMPT),
    outputSchemaSha256: sha256(JSON.stringify(z.toJSONSchema(CauseOutput))),
    modelId: MODEL_ID,
    llmParams: LLM_PARAMS,
    b1Md5: md5(readFileSync(join(root, "eval/baseline/B1.mjs"))),
    productSources: Object.fromEntries(productSourceFiles(root).map((f) => [f, sha256(readFileSync(join(root, f)))])),
    packages: Object.fromEntries(FROZEN_PACKAGES.map((p) => [p, (JSON.parse(readFileSync(join(root, "node_modules", p, "package.json"), "utf8")) as { version: string }).version])),
  };
}

// Differences between the committed freeze and the code as it is now. Empty = frozen.
export function freezeProblems(committed: Freeze, now: Freeze): string[] {
  const problems: string[] = [];
  if (now.b1Md5 !== B1_MD5) problems.push(`B1 md5 is ${now.b1Md5}, plan 6.3 says ${B1_MD5}`);
  for (const k of ["promptVersion", "systemPromptSha256", "outputSchemaSha256", "modelId", "b1Md5"] as const) if (committed[k] !== now[k]) problems.push(`${k}: frozen ${committed[k]}, now ${now[k]}`);
  if (JSON.stringify(committed.llmParams) !== JSON.stringify(now.llmParams)) problems.push("llmParams differ from the freeze");
  for (const p of new Set([...Object.keys(committed.packages ?? {}), ...Object.keys(now.packages)])) {
    if (committed.packages?.[p] !== now.packages[p]) problems.push(`package ${p}: frozen ${committed.packages?.[p] ?? "none"}, installed ${now.packages[p] ?? "none"}`);
  }
  for (const f of new Set([...Object.keys(committed.productSources), ...Object.keys(now.productSources)])) {
    if (committed.productSources[f] !== now.productSources[f]) problems.push(`product source ${f} ${committed.productSources[f] ? (now.productSources[f] ? "changed" : "removed") : "added"} since the freeze`);
  }
  return problems;
}
