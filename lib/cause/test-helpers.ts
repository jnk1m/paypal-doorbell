// Shared by the cause tests: mock models (a real answer, an unreadable one, an empty one, a 429, a hang), a tiny diff builder, and the
// dev-set cases as inputs. Everything here is offline.
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "ai";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCase } from "../../eval/harness/case.ts";
import { prepareInput } from "./input.ts";
import type { CauseInput } from "./prompt.ts";
import type { SymptomClass } from "./categories.ts";
import type { CallOutcome, LiveGate } from "./cause.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};
const text = (t: string) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({ content: [{ type: "text", text: t }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }),
  });

export const answering = (json: unknown) => text(JSON.stringify(json));
export const answeringText = text;
export const throwing = (error: unknown) =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw error;
    },
  });
export const rateLimited = () => throwing(new APICallError({ message: "rate limited", url: "https://api.anthropic.com/v1/messages", requestBodyValues: { secretPrompt: "LEAK-CHECK" }, statusCode: 429, isRetryable: true }));
// Never answers; ends when the call's abort signal fires, like a real request that times out.
export const hanging = () =>
  new MockLanguageModelV4({
    doGenerate: (options) =>
      new Promise((_, reject) => {
        options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal!.reason));
      }),
  });

export function devInput(id: string): { input: CauseInput; label: ReturnType<typeof loadCase>["label"] } {
  const c = loadCase(join(ROOT, "eval/dev", id));
  return { input: prepareInput({ diff: c.diff, before: c.before, after: c.after, symptom: c.symptom }).input, label: c.label };
}

// A diff that inserts `added` into `before` at line index `at` (a pure insertion, the whole file as context).
export function insertionCase(file: string, before: string[], at: number, added: string[], symptom: SymptomClass = "all_401") {
  const after = [...before.slice(0, at), ...added, ...before.slice(at)];
  const body = [...before.slice(0, at).map((l) => ` ${l}`), ...added.map((l) => `+${l}`), ...before.slice(at).map((l) => ` ${l}`)];
  const diff = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${before.length} +1,${after.length} @@\n${body.join("\n")}\n`;
  return prepareInput({ diff, before: { [file]: `${before.join("\n")}\n` }, after: { [file]: `${after.join("\n")}\n` }, symptom }).input;
}

export const idOfText = (input: CauseInput, needle: string): string => {
  for (const f of input.diff.files) for (const h of f.hunks) for (const l of h.lines) if (l.id && l.text.includes(needle)) return l.id;
  throw new Error(`no changed line with ${needle}`);
};

// A gate that lets every call through and writes down what each call reported back (the outcome the budget would settle on).
export function openGate() {
  const outcomes: CallOutcome[] = [];
  const asked: number[] = [];
  const gate: LiveGate = {
    acquire: async ({ worstCaseUsd }) => (asked.push(worstCaseUsd), { ok: true, settle: async (o) => void outcomes.push(o) }),
  };
  return Object.assign(gate, { outcomes, asked });
}
