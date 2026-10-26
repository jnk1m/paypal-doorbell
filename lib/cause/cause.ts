// The cause step (R7, R8): the model proposes, code confirms, and anything that goes wrong closes.
//
//   input (diff + files + symptom class)  ->  request  ->  recording, or a live call when allowed  ->  C2, C1'  ->  CauseResult
//
// The default path is the recording (plan 5.4 #6, 9.14): a live call happens only on a missing recording with onMiss "call", or when
// the caller asks for mode "live" / "record" (the "model re-run" button, the harness, the recorder script). EVERY live call needs a
// gate (hourly limit + money budget): without one diagnose() throws instead of calling, so no code path can spend money unchecked.
// Whatever fails -- timeout, unreadable output, 429, empty answer, no recording, a gate that says no, an input that is refused -- ends as
// status "not_diagnosed" with a fixed reason. The reason is a word from a closed list, never the error's text (an AI SDK error can
// carry the prompt).
import type { LanguageModel } from "ai";
import { callLlm, MissingKeyError, modeFromEnv, RecordingMissingError, requestHash, worstCaseUsd, type LlmMode, type LlmUsage } from "../core/llm.ts";
import { NOT_DIAGNOSED_TEXT, NOT_PROVEN_TEXT, type Category } from "./categories.ts";
import { checkCause, type EvidenceLine, type NotProvenReason } from "./checks.ts";
import { InputRejected } from "./hygiene.ts";
import { buildRequest, CauseOutput, PROMPT_VERSION, type CauseInput } from "./prompt.ts";

export type NotDiagnosedReason = "timeout" | "network" | "bad_json" | "empty" | "rate_limited" | "upstream_error" | "auth_or_billing" | "no_key" | "no_recording" | "input_rejected" | "budget" | "call_cap" | "error";

interface Base {
  promptVersion: string;
  requestHash: string; // sha256 of the request: the recording's name ("" when the input was refused before a request existed)
}
export type CauseResult =
  | (Base & { status: "proposed"; category: Exclude<Category, "NOT_IN_DIFF">; file: string; hunkId: string; lines: EvidenceLine[]; explanation: string; source: "recording" | "live" })
  | (Base & { status: "not_proven"; reason: NotProvenReason; text: typeof NOT_PROVEN_TEXT })
  | (Base & { status: "not_diagnosed"; reason: NotDiagnosedReason; text: typeof NOT_DIAGNOSED_TEXT });

// What happened to the money of a live call, for the gate: billed with this usage, definitely not billed (give the reservation back), or not known
// (a timeout or an abort: the provider may still have run it, so the reservation stays).
export type CallOutcome = { billed: "yes"; usage: LlmUsage } | { billed: "no" } | { billed: "unknown" };
export type LiveGrant = { ok: true; settle: (outcome: CallOutcome) => Promise<void> } | { ok: false; reason: "rate_limited" | "budget" };
export interface LiveGate {
  /** worstCaseUsd: the most this call can cost, from its own request (llm.ts worstCaseUsd). */
  acquire(call: { worstCaseUsd: number }): Promise<LiveGrant>;
}

export interface DiagnoseOptions {
  mode?: LlmMode; // replay (default, from RECORD) | record | live
  onMiss?: "none" | "call"; // replay finds no recording: stop (default) or make one live call
  dir?: string;
  model?: LanguageModel; // tests inject a mock
  timeoutMs?: number;
  gate?: LiveGate; // REQUIRED for any live call: mode live/record, or onMiss "call"
  onLiveCall?: () => void; // a live call is about to be made
  onUsage?: (usage: LlmUsage) => void;
  log?: (line: Record<string, unknown>) => void;
}

class GateRefused extends Error {
  constructor(readonly reason: "rate_limited" | "budget") {
    super(`live call refused: ${reason}`);
    this.name = "GateRefused";
  }
}

// A closed list of reasons. Anything this function does not recognise is "error".
export function failureReason(e: unknown): NotDiagnosedReason {
  if (e instanceof RecordingMissingError) return "no_recording";
  if (e instanceof InputRejected) return "input_rejected";
  if (e instanceof GateRefused) return e.reason;
  if (e instanceof MissingKeyError) return "no_key";
  const err = e as { name?: unknown; statusCode?: unknown; text?: unknown; cause?: unknown; message?: unknown } | null;
  const name = typeof err?.name === "string" ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const status = typeof err?.statusCode === "number" ? err.statusCode : undefined;
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 402 || status === 403) return "auth_or_billing";
  if (status !== undefined && status >= 500) return "upstream_error";
  // Any other HTTP error (400 over-long prompt, 404 unknown model, 413) is the same answer on every try: a result, not a network fault.
  if (status !== undefined && status >= 400) return "error";
  if (/NoObjectGenerated|NoOutputGenerated|NoContentGenerated|EmptyResponseBody/.test(name)) return typeof err?.text === "string" && err.text.trim() !== "" ? "bad_json" : "empty";
  if (/JSONParse|TypeValidation|ZodError/.test(name)) return "bad_json";
  // The request never got an HTTP answer: DNS, connection reset, offline.
  if (/APICallError/.test(name) || (name === "TypeError" && typeof err?.message === "string" && /fetch failed/i.test(err.message))) return "network";
  if (err?.cause !== undefined && err.cause !== e) return failureReason(err.cause);
  return "error";
}

// True only when the request is known to have produced nothing to pay for: no key was there to send, or the provider answered with an HTTP
// error status (rejected before any generation). A timeout, an abort or anything unrecognised is NOT in this list: the reservation stays.
function definitelyUnbilled(e: unknown): boolean {
  if (e instanceof MissingKeyError) return true;
  const status = (e as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" && status >= 400;
}

const fail = (base: Base, reason: NotDiagnosedReason): CauseResult => ({ ...base, status: "not_diagnosed", reason, text: NOT_DIAGNOSED_TEXT });

export async function diagnose(input: CauseInput, opts: DiagnoseOptions = {}): Promise<CauseResult> {
  const requested = opts.mode ?? modeFromEnv();
  if ((requested !== "replay" || opts.onMiss === "call") && !opts.gate) {
    throw new Error("diagnose: a live model call (mode live/record, or onMiss \"call\") needs opts.gate, the hourly limit plus the money budget; use gate.ts");
  }
  const log = opts.log ?? ((line) => console.log(JSON.stringify({ route: "cause", ...line })));
  let req;
  try {
    req = buildRequest(input);
  } catch (e) {
    const reason = failureReason(e);
    log({ outcome: "not_diagnosed", reason });
    return fail({ promptVersion: PROMPT_VERSION, requestHash: "" }, reason);
  }
  const base: Base = { promptVersion: req.version, requestHash: requestHash(req) };
  const short = base.requestHash.slice(0, 12);
  let usage: LlmUsage | undefined;
  let grant: Extract<LiveGrant, { ok: true }> | undefined;
  let source: "recording" | "live" = "recording";
  const common = { dir: opts.dir, model: opts.model, timeoutMs: opts.timeoutMs, onUsage: (u: LlmUsage) => ((usage = u), opts.onUsage?.(u)) };

  const live = async (): Promise<CauseOutput> => {
    const g = await opts.gate!.acquire({ worstCaseUsd: worstCaseUsd(req) });
    if (!g.ok) throw new GateRefused(g.reason);
    grant = g;
    source = "live";
    opts.onLiveCall?.();
    return callLlm(req, CauseOutput, { ...common, mode: requested === "replay" ? "live" : requested });
  };

  try {
    let out: CauseOutput;
    if (requested === "replay") {
      try {
        out = await callLlm(req, CauseOutput, { ...common, mode: "replay" });
      } catch (e) {
        if (e instanceof RecordingMissingError && opts.onMiss === "call") out = await live();
        else throw e;
      }
    } else {
      out = await live();
    }
    await grant?.settle(usage ? { billed: "yes", usage } : { billed: "unknown" });
    const checked = checkCause(out, input.diff, input.symptom);
    if (!checked.ok) {
      log({ outcome: "not_proven", reason: checked.reason, hash: short, source });
      return { ...base, status: "not_proven", reason: checked.reason, text: NOT_PROVEN_TEXT };
    }
    log({ outcome: "proposed", category: checked.category, hash: short, source });
    return { ...base, status: "proposed", category: checked.category, file: checked.file, hunkId: checked.hunkId, lines: checked.lines, explanation: checked.explanation, source };
  } catch (e) {
    // What the call cost decides what happens to the reservation: billed (the provider reported usage), definitely not billed, or unknown.
    await grant?.settle(usage ? { billed: "yes", usage } : definitelyUnbilled(e) ? { billed: "no" } : { billed: "unknown" }).catch(() => undefined);
    const reason = failureReason(e);
    log({ outcome: "not_diagnosed", reason, hash: short, errorName: e instanceof Error ? e.name : typeof e });
    return fail(base, reason);
  }
}

// Plan 9.5: a scan makes at most one model call per kind of gap and at most 3 in all. Identical requests are answered once. Once the
// cap is spent, a request that would need a live call is "not diagnosed" (call_cap) without one. Recordings are free and never count.
export const MAX_MODEL_CALLS_PER_SCAN = 3;
export async function diagnoseMany(inputs: CauseInput[], opts: DiagnoseOptions = {}): Promise<CauseResult[]> {
  const answered = new Map<string, CauseResult>();
  let calls = 0;
  const results: CauseResult[] = [];
  for (const input of inputs) {
    let hash: string;
    try {
      hash = requestHash(buildRequest(input));
    } catch {
      results.push(await diagnose(input, opts)); // refused input: the reason comes from diagnose
      continue;
    }
    const known = answered.get(hash);
    if (known) {
      results.push(known);
      continue;
    }
    const capped = calls >= MAX_MODEL_CALLS_PER_SCAN;
    const r = await diagnose(input, {
      ...opts,
      onLiveCall: () => {
        calls++;
        opts.onLiveCall?.();
      },
      ...(capped ? { mode: "replay" as const, onMiss: "none" as const } : {}),
    });
    const final: CauseResult = capped && r.status === "not_diagnosed" && r.reason === "no_recording" ? { ...r, reason: "call_cap" } : r;
    answered.set(hash, final);
    results.push(final);
  }
  return results;
}
