// The replay referee for a patched handler. The patched file runs in the sandbox child (sandbox.ts) on REAL signed PayPal deliveries that the
// witness stored, next to the last good build, and three controls decide:
//
//   real      the deliveries in the order they arrived          -> answers and books must equal the good build's, and the books must equal PayPal's own answer
//   reversed  the same deliveries, last one first               -> same (a late "paid" after a "refunded" is exactly what the order guard is for)
//   tampered  the real order, one amount in every body changed  -> 401 on every delivery and nothing booked, like the good build. A "fix" that
//                                                                  deletes the signature check books the tampered amounts and fails here.
//
// `verify` inside the child is answered by the parent: from an answer PayPal already gave for the very same (delivery, body), or by a live
// call to PayPal's verify endpoint (VerifyFn). The proof claim is only ever "behaves like the good build and PayPal's answer on these N
// inputs"; it never says "correct".
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { VerifyParams } from "../pay/paypal.ts";
import { runSandboxed, type RunOutcome, type SandboxResult } from "./sandbox.ts";

export interface Delivery {
  raw: string;
  headers: { transmissionId: string; transmissionTime: string; transmissionSig: string; certUrl: string; authAlgo: string };
  webhookId: string;
}

export interface Scenario {
  capture: string;
  truth: "paid" | "refunded"; // what PayPal's own GET capture says, in the shop's words
  deliveries: Delivery[]; // in the order they arrived
}

export type RunName = "real" | "reversed" | "tampered";
export interface RunSpec {
  scenario: number;
  name: RunName;
  deliveries: Delivery[];
}

// One amount in the body changed: the body still looks like a booking event, but it is no longer what PayPal signed.
export function tamper(raw: string): string {
  const out = raw.replace(/("amount":\{"currency_code":"[A-Z]{3}","value":")(\d{1,8})(\.\d{2}"\})/, (_m, a: string, int: string, c: string) => `${a}${Number(int) + 1}${c}`);
  if (out === raw) throw new Error("tamper: found no amount to change in the body");
  return out;
}

export function buildRuns(scenarios: Scenario[]): RunSpec[] {
  return scenarios.flatMap((s, i) => [
    { scenario: i, name: "real" as const, deliveries: s.deliveries },
    { scenario: i, name: "reversed" as const, deliveries: [...s.deliveries].reverse() },
    { scenario: i, name: "tampered" as const, deliveries: s.deliveries.map((d) => ({ ...d, raw: tamper(d.raw) })) },
  ]);
}

export type VerifyFn = (p: VerifyParams) => Promise<string | undefined>;

// PayPal's answers, remembered by (delivery, webhook, exact event). The same body asked twice is answered once.
export class CachedVerifier {
  readonly stats = { live: 0, cached: 0 };
  private readonly known = new Map<string, string>();
  constructor(
    private readonly live?: VerifyFn,
    private readonly file?: string,
  ) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const [key, status] = JSON.parse(line) as [string, string];
        this.known.set(key, status);
      }
    }
  }

  static keyOf(p: VerifyParams): string {
    return createHash("sha256").update(JSON.stringify([p.transmissionId, p.webhookId, JSON.stringify(p.webhookEvent ?? null)])).digest("hex");
  }

  async verify(p: VerifyParams): Promise<string | undefined> {
    const key = CachedVerifier.keyOf(p);
    const hit = this.known.get(key);
    if (hit !== undefined) {
      this.stats.cached++;
      return hit;
    }
    if (!this.live) throw new Error("verify: PayPal has not answered this exact delivery before and no live verify is available");
    const status = await this.live(p);
    this.stats.live++;
    if (status === "SUCCESS" || status === "FAILURE") {
      this.known.set(key, status);
      if (this.file) appendFileSync(this.file, `${JSON.stringify([key, status])}\n`);
    }
    return status;
  }
}

// A verify call that could not be answered (PayPal unreachable, no stored answer) is not the handler's fault: it is reported apart.
export async function runBuild(handlerTs: string, runs: RunSpec[], verifier: CachedVerifier, timeoutMs?: number): Promise<{ result: SandboxResult; verifyErrors: string[] }> {
  const verifyErrors: string[] = [];
  const result = await runSandboxed({
    handlerTs,
    runs: runs.map((r) => r.deliveries.map((d) => d.raw)),
    timeoutMs,
    broker: async ({ run, delivery, event }) => {
      const d = runs[run]?.deliveries[delivery];
      if (!d) throw new Error("verify asked about a delivery that does not exist");
      try {
        return await verifier.verify({ authAlgo: d.headers.authAlgo, certUrl: d.headers.certUrl, transmissionId: d.headers.transmissionId, transmissionSig: d.headers.transmissionSig, transmissionTime: d.headers.transmissionTime, webhookId: d.webhookId, webhookEvent: event });
      } catch (e) {
        verifyErrors.push(e instanceof Error ? e.message.slice(0, 120) : "verify failed");
        throw e;
      }
    },
  });
  return { result, verifyErrors };
}

const same = (a: RunOutcome, b: RunOutcome): boolean => JSON.stringify([a.statuses, a.books]) === JSON.stringify([b.statuses, b.books]);

export interface RunVerdict {
  scenario: number;
  capture: string;
  name: RunName;
  sameAsGood: boolean;
  matchesPaypal?: boolean; // real and reversed only
  good: { statuses: number[]; books: RunOutcome["books"] };
  got: { statuses: number[]; books: RunOutcome["books"]; errors: string[] };
}

export interface RefereeResult {
  /** The candidate could not be judged because PayPal could not be asked: not a verdict about the code. */
  infra?: { reason: string; detail: string };
  /** The candidate's code did not run (it does not load, loops forever, crashes the process): a failure of the code. */
  codeFailure?: { reason: string; detail: string };
  pass: boolean;
  controls: { real: boolean; reversed: boolean; tampered: boolean; paypal: boolean };
  runs: RunVerdict[];
  inputs: number; // deliveries replayed in the runs of the candidate
  claim: string;
}

export class Referee {
  private good: RunOutcome[] = [];
  /** Scenarios the good build itself does not satisfy (the control would be meaningless) are dropped and listed here. */
  readonly dropped: { capture: string; why: string }[] = [];
  private runs: RunSpec[] = [];
  private truth: Scenario[] = [];

  constructor(
    private readonly scenarios: Scenario[],
    readonly goodTs: string,
    readonly verifier: CachedVerifier,
  ) {}

  /** Runs the good build once and keeps only the scenarios on which it behaves as the controls expect. */
  async prepare(): Promise<void> {
    const all = buildRuns(this.scenarios);
    const built = await runBuild(this.goodTs, all, this.verifier);
    const r = built.result;
    if (built.verifyErrors.length) throw new Error(`referee: PayPal could not be asked to verify the good build's deliveries: ${built.verifyErrors[0]}`);
    if (!r.ok) throw new Error(`referee: the good build could not be run: ${r.reason}: ${r.detail}`);
    const keep: number[] = [];
    this.scenarios.forEach((s, i) => {
      const [real, reversed, tampered] = [0, 1, 2].map((k) => r.runs[i * 3 + k]);
      const why: string[] = [];
      for (const [name, run] of [["real", real], ["reversed", reversed]] as const) {
        if (!run.statuses.every((x) => x === 200)) why.push(`good build answered ${run.statuses.join("/")} on the ${name} run`);
        if (run.books[s.capture]?.state !== s.truth) why.push(`good build books ${run.books[s.capture]?.state ?? "nothing"} on the ${name} run but PayPal says ${s.truth}`);
      }
      if (!tampered.statuses.every((x) => x === 401) || Object.keys(tampered.books).length > 0) why.push(`the tampered control does not separate: good build answered ${tampered.statuses.join("/")} and booked ${Object.keys(tampered.books).length}`);
      if (why.length) this.dropped.push({ capture: s.capture, why: why.join("; ") });
      else keep.push(i);
    });
    this.truth = keep.map((i) => this.scenarios[i]);
    this.runs = buildRuns(this.truth);
    this.good = keep.flatMap((i) => [0, 1, 2].map((k) => r.runs[i * 3 + k]));
    if (this.truth.length === 0) throw new Error(`referee: no scenario is usable: ${JSON.stringify(this.dropped)}`);
  }

  get scenarioCount(): number {
    return this.truth.length;
  }

  async judge(candidateTs: string): Promise<RefereeResult> {
    const base = { controls: { real: false, reversed: false, tampered: false, paypal: false }, runs: [], inputs: 0 };
    const built = await runBuild(candidateTs, this.runs, this.verifier);
    if (built.verifyErrors.length) return { ...base, pass: false, infra: { reason: "verify_unavailable", detail: built.verifyErrors[0] }, claim: "not judged" };
    const r = built.result;
    if (!r.ok) return { ...base, pass: false, codeFailure: { reason: r.reason, detail: r.detail }, claim: "not proven" };
    const verdicts: RunVerdict[] = this.runs.map((spec, i) => {
      const sc = this.truth[spec.scenario];
      const got = r.runs[i];
      const verdict: RunVerdict = {
        scenario: spec.scenario,
        capture: sc.capture,
        name: spec.name,
        sameAsGood: same(got, this.good[i]) && got.errors.length === 0,
        good: { statuses: this.good[i].statuses, books: this.good[i].books },
        got: { statuses: got.statuses, books: got.books, errors: got.errors },
      };
      if (spec.name !== "tampered") verdict.matchesPaypal = got.books[sc.capture]?.state === sc.truth;
      return verdict;
    });
    const every = (name: RunName, pred: (v: RunVerdict) => boolean) => verdicts.filter((v) => v.name === name).every(pred);
    const controls = { real: every("real", (v) => v.sameAsGood), reversed: every("reversed", (v) => v.sameAsGood), tampered: every("tampered", (v) => v.sameAsGood), paypal: verdicts.filter((v) => v.name !== "tampered").every((v) => v.matchesPaypal === true) };
    const inputs = this.runs.reduce((n, spec) => n + spec.deliveries.length, 0);
    const pass = controls.real && controls.reversed && controls.tampered && controls.paypal;
    return { pass, controls, runs: verdicts, inputs, claim: pass ? `behaves like the good build and PayPal's answer on these ${inputs} inputs (${this.truth.length} orders x real order, reversed, tampered)` : "not proven" };
  }
}

// A one-line, fixed-words description of what differed, for the round-2 feedback and the log. Statuses and book states only.
export function describeFailures(result: RefereeResult): string[] {
  const lines: string[] = [];
  const books = (b: RunOutcome["books"]) => (Object.keys(b).length === 0 ? "booked nothing" : Object.values(b).map((e) => `booked ${e.state}`).join(", "));
  const seen = new Set<string>();
  for (const v of result.runs) {
    if (v.sameAsGood && v.matchesPaypal !== false) continue;
    const key = `${v.name}:${v.good.statuses.join("/")}:${books(v.good.books)}:${v.got.statuses.join("/")}:${books(v.got.books)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const what = v.name === "real" ? "the events in the order they arrived" : v.name === "reversed" ? "the same events, last one first" : "the events with one amount in the body changed (the signature no longer matches)";
    lines.push(`${what}: the good build answered ${v.good.statuses.join("/")} and ${books(v.good.books)}; your patched build answered ${v.got.statuses.join("/")} and ${books(v.got.books)}${v.got.errors.length ? ` (it threw: ${v.got.errors[0].slice(0, 80)})` : ""}.`);
  }
  return lines;
}
