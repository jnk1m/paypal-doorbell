// The fix step's own model wrapper (copied from the pattern in lib/core/llm.ts, which is frozen and whose task type is only "cause").
//   replay (default): answer from fixtures/fix-recordings/<hash>.json; a missing hash throws
//   live: call the model and write the recording (needs ANTHROPIC_API_KEY and a spend ledger)
// The key is sha256(model + prompt version + system + prompt), so a changed prompt never replays a stale answer. Spend is capped by a ledger
// the caller passes in (a file, so the cap holds across runs).
//
// LOCAL ONLY: scripts/record-fix.ts is the only caller. Nothing that a deployed function imports reaches this file (recorded.test.ts checks the
// import graph), so no model call can be made at request time.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, Output } from "ai";
import type { z } from "zod";
import { costUsd, MODEL_ID, type LlmUsage } from "../core/llm.ts";

export const FIX_MAX_OUTPUT_TOKENS = 6000; // reasoning included
export const FIX_TIMEOUT_MS = 90_000;
export const FIX_LLM_PARAMS = { sdk: "ai", provider: "@ai-sdk/anthropic", model: MODEL_ID, maxOutputTokens: FIX_MAX_OUTPUT_TOKENS, timeoutMs: FIX_TIMEOUT_MS, maxRetries: 0, temperature: "dropped by the SDK for this model", structuredOutput: "Output.object(zod)" } as const;

export interface FixLlmRequest {
  version: string;
  system: string;
  prompt: string;
}

export const fixRequestHash = (r: FixLlmRequest): string => createHash("sha256").update(JSON.stringify([MODEL_ID, r.version, r.system, r.prompt])).digest("hex");

export const worstCaseFixUsd = (r: FixLlmRequest): number => costUsd({ inputTokens: Math.ceil((Buffer.byteLength(r.system) + Buffer.byteLength(r.prompt)) / 1.25) + 1000, outputTokens: FIX_MAX_OUTPUT_TOKENS, reasoningTokens: 0 });

// Every dollar spent on fix calls, in a file: the cap is over the sum of all runs.
export class Ledger {
  constructor(
    private readonly file: string,
    readonly capUsd: number,
  ) {}

  total(): number {
    if (!existsSync(this.file)) return 0;
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .reduce((sum, l) => sum + (JSON.parse(l) as { usd: number }).usd, 0);
  }

  /** Throws before a call that could take the total past the cap. */
  assertRoom(worstCaseUsd: number, what: string): void {
    const total = this.total();
    if (total + worstCaseUsd > this.capUsd) throw new CapReached(`${what}: spent $${total.toFixed(3)}, this call could cost $${worstCaseUsd.toFixed(3)}, cap $${this.capUsd.toFixed(2)}`);
  }

  add(row: { kind: string; caseId: string; usage: LlmUsage; hash: string }): number {
    const usd = costUsd(row.usage);
    appendFileSync(this.file, `${JSON.stringify({ at: new Date().toISOString(), ...row, hash: row.hash.slice(0, 12), usd })}\n`);
    return usd;
  }
}

export class CapReached extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapReached";
  }
}

export class FixRecordingMissing extends Error {
  constructor(hash: string) {
    super(`no recorded fix answer ${hash.slice(0, 12)}: the prompt or input changed; run scripts/record-fix.ts with --live to record (spends money)`);
    this.name = "FixRecordingMissing";
  }
}

interface Recording<T> {
  hash: string;
  version: string;
  model: string;
  at: string; // when the answer was recorded
  system: string;
  prompt: string;
  usage: LlmUsage;
  output: T;
}

export interface FixCall<T> {
  output: T;
  usage: LlmUsage;
  costUsd: number;
  source: "recording" | "live";
  hash: string;
  recordedAt: string; // ISO time of the live call that made the recording
}

export async function callFixLlm<S extends z.ZodType>(req: FixLlmRequest, schema: S, opts: { dir: string; live: boolean; ledger?: Ledger; caseId: string }): Promise<FixCall<z.infer<S>>> {
  const hash = fixRequestHash(req);
  const file = join(opts.dir, `${hash}.json`);
  if (existsSync(file)) {
    const rec = JSON.parse(readFileSync(file, "utf8")) as Recording<unknown>;
    return { output: schema.parse(rec.output), usage: rec.usage, costUsd: costUsd(rec.usage), source: "recording", hash, recordedAt: rec.at };
  }
  if (!opts.live) throw new FixRecordingMissing(hash);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("a live fix call needs ANTHROPIC_API_KEY");
  if (!opts.ledger) throw new Error("a live fix call needs a spend ledger");
  opts.ledger.assertRoom(worstCaseFixUsd(req), `fix call for ${opts.caseId}`);
  let usage: LlmUsage | undefined;
  const note = (u: { inputTokens?: number; outputTokens?: number; outputTokenDetails?: { reasoningTokens?: number } } | undefined) => {
    if (u) usage = { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? 0 };
  };
  let result;
  try {
    result = await generateText({ model: anthropic(MODEL_ID), instructions: req.system, prompt: req.prompt, temperature: 0, maxOutputTokens: FIX_MAX_OUTPUT_TOKENS, maxRetries: 0, abortSignal: AbortSignal.timeout(FIX_TIMEOUT_MS), output: Output.object({ schema }) });
  } catch (e) {
    note((e as { usage?: Parameters<typeof note>[0] }).usage);
    if (usage) opts.ledger.add({ kind: "fix", caseId: opts.caseId, usage, hash }); // an answer that could not be parsed was still paid for
    throw e;
  }
  note(result.usage);
  if (usage) opts.ledger.add({ kind: "fix", caseId: opts.caseId, usage, hash });
  const output = schema.parse(result.output);
  mkdirSync(opts.dir, { recursive: true });
  const rec: Recording<unknown> = { hash, version: req.version, model: MODEL_ID, at: new Date().toISOString(), system: req.system, prompt: req.prompt, usage: usage ?? { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, output };
  writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  return { output, usage: rec.usage, costUsd: costUsd(rec.usage), source: "live", hash, recordedAt: rec.at };
}
