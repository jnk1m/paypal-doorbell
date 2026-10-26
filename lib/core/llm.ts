// One place that talks to the model, with record/replay.
//   replay (default): answer from fixtures/recordings/<hash>.json. A missing hash throws: the prompt or input changed, re-record.
//   record (RECORD=1): call the live model and write the recording. Needs ANTHROPIC_API_KEY.
//   live: call the live model and write nothing (live checks, the hosted demo).
// The recording key is sha256(model + prompt version + system prompt + prompt), so an edited prompt can never replay a stale answer.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateText, Output, type LanguageModel, type LanguageModelUsage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { z } from "zod";

export const MODEL_ID = "claude-sonnet-5-5";
// Built with path.join, not new URL("...", import.meta.url): Next/Turbopack reads that pattern as an asset import and fails when the folder is missing.
export const RECORDINGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/recordings/");

export type LlmMode = "replay" | "record" | "live";

// Output cap per task (thinking included). Bounds the cost of one call on the public demo (plan 9.5: 2,000 output tokens).
const MAX_OUTPUT_TOKENS: Record<LlmRequest["task"], number> = { cause: 2000 };
const CALL_TIMEOUT_MS = 30_000;

// Everything about a call that is not the prompt (plan 6.4: frozen for the evaluation, recorded with every harness result).
// claude-sonnet-5-5 does not accept temperature (the SDK drops it); thinking and effort are left at the provider's defaults.
// No hidden retries: a 429 or a 5xx ends the call at once (R8 fails closed); the harness re-runs infrastructure failures itself and counts them.
const MAX_RETRIES = 0;
export const LLM_PARAMS = { sdk: "ai", provider: "@ai-sdk/anthropic", model: MODEL_ID, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: CALL_TIMEOUT_MS, maxRetries: MAX_RETRIES, temperature: "unsupported (dropped by the SDK)", thinking: "provider default (not set by us; reasoning tokens count inside the 2,000 output cap)", effort: "provider default", structuredOutput: "Output.object(zod)" } as const;

// USD per million tokens (claude-sonnet-5-5), for the budget and for measured spend.
export const PRICE_USD_PER_MTOK = { input: 2, output: 10 } as const;
export const costUsd = (u: LlmUsage): number => (u.inputTokens * PRICE_USD_PER_MTOK.input + u.outputTokens * PRICE_USD_PER_MTOK.output) / 1e6;

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

// The most one call can cost, worked out from the request alone (before any money is spent): the input at one token per 1.25 bytes
// (measured requests are 2.1-2.3 bytes per token, so this is generous even for dense code, symbols or base64), plus 1,000 tokens for the
// structured-output wrapper, plus the full output cap. The budget reserves this amount; the real cost settles it afterwards.
export const BYTES_PER_INPUT_TOKEN_FLOOR = 1.25;
export const WRAPPER_TOKENS = 1000;
export function worstCaseUsd(req: LlmRequest): number {
  const inputTokens = Math.ceil((Buffer.byteLength(req.system) + Buffer.byteLength(req.prompt)) / BYTES_PER_INPUT_TOKEN_FLOOR) + WRAPPER_TOKENS;
  return costUsd({ inputTokens, outputTokens: MAX_OUTPUT_TOKENS[req.task], reasoningTokens: 0 });
}

// Thrown before any request is made: the call would have needed a key that is not there. Nothing was sent, nothing is billed.
export class MissingKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingKeyError";
  }
}

export interface LlmRequest {
  task: "cause";
  version: string; // bump it whenever the prompt text or its output contract changes
  system: string;
  prompt: string;
}

export interface LlmOptions {
  mode?: LlmMode;
  dir?: string; // recordings directory (tests use a temp one)
  model?: LanguageModel; // tests inject a mock model
  timeoutMs?: number; // tests shorten it; the product uses CALL_TIMEOUT_MS
  onUsage?: (usage: LlmUsage) => void; // called once per live call, before the output is parsed, so spend is counted even when parsing fails
}

// RECORD=1 means "record" only off Vercel: a deployed function never records, whatever its environment says (it answers from recordings).
export const modeFromEnv = (): LlmMode => (process.env.RECORD === "1" && !process.env.VERCEL ? "record" : "replay");

export class RecordingMissingError extends Error {
  constructor(
    readonly hash: string,
    task: string,
    version: string,
    dir: string,
  ) {
    super(
      `No recorded LLM answer for task "${task}" (prompt version ${version}, key ${hash.slice(0, 12)}) in ${dir}. ` +
        `The prompt, the model id or the input changed since the recordings were made. ` +
        `Re-record with RECORD=1 (needs ANTHROPIC_API_KEY).`,
    );
    this.name = "RecordingMissingError";
  }
}

export function requestHash(req: LlmRequest, model: string = MODEL_ID): string {
  return createHash("sha256").update(JSON.stringify([model, req.version, req.system, req.prompt])).digest("hex");
}

export function hasRecordings(dir: string = RECORDINGS_DIR): boolean {
  return existsSync(/*turbopackIgnore: true*/ dir) && readdirSync(/*turbopackIgnore: true*/ dir).some((f) => f.endsWith(".json")); // only tests and scripts call this; the comments keep Next from tracing the whole project
}

// claude-sonnet-5-5 does not accept temperature; the SDK drops it and warns. Print each distinct warning once.
const seenWarnings = new Set<string>();
if (globalThis.AI_SDK_LOG_WARNINGS === undefined) {
  globalThis.AI_SDK_LOG_WARNINGS = ({ warnings }) => {
    for (const w of warnings) {
      const text = JSON.stringify(w);
      if (!seenWarnings.has(text)) {
        seenWarnings.add(text);
        console.warn(`[ai-sdk warning] ${text}`);
      }
    }
  };
}

interface Recording<T> {
  task: string;
  model: string;
  version: string;
  hash: string;
  system: string;
  prompt: string;
  warnings: unknown[];
  usage?: unknown; // token counts from the live call, for cost estimates
  output: T;
}

export async function callLlm<S extends z.ZodType>(req: LlmRequest, schema: S, opts: LlmOptions = {}): Promise<z.infer<S>> {
  const mode = opts.mode ?? modeFromEnv();
  const dir = opts.dir ?? RECORDINGS_DIR;
  const hash = requestHash(req);
  const file = `${dir}${dir.endsWith("/") ? "" : "/"}${hash}.json`;

  if (mode === "replay") {
    if (!existsSync(file)) throw new RecordingMissingError(hash, req.task, req.version, dir);
    const rec = JSON.parse(readFileSync(file, "utf8")) as Recording<unknown>;
    return schema.parse(rec.output);
  }

  if (!opts.model && !process.env.ANTHROPIC_API_KEY) {
    throw new MissingKeyError(`${mode === "record" ? "RECORD=1" : "Live LLM call"} needs ANTHROPIC_API_KEY (task "${req.task}", prompt version ${req.version}).`);
  }
  const spent = (u: Partial<LanguageModelUsage> | undefined) => {
    if (u) opts.onUsage?.({ inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? 0 });
  };
  let result;
  try {
    result = await generateText({
      model: opts.model ?? anthropic(MODEL_ID),
      instructions: req.system,
      prompt: req.prompt,
      temperature: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS[req.task],
      maxRetries: MAX_RETRIES,
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? CALL_TIMEOUT_MS),
      output: Output.object({ schema }),
    });
  } catch (e) {
    spent((e as { usage?: LanguageModelUsage }).usage); // an answer that could not be parsed was still paid for
    throw e;
  }
  spent(result.usage);
  const output = schema.parse(result.output);

  if (mode === "record") {
    mkdirSync(dir, { recursive: true });
    const rec: Recording<unknown> = {
      task: req.task,
      model: MODEL_ID,
      version: req.version,
      hash,
      system: req.system,
      prompt: req.prompt,
      warnings: result.warnings ?? [],
      usage: result.usage,
      output,
    };
    writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  }
  return output;
}
