// Builds a FixResult (types.ts) from what the checks and the referee found. Pure. LOCAL ONLY (record time): a deployed function reads the
// result this builds from fixtures/fix/results.json, it never builds one.
import { createHash } from "node:crypto";
import { diffFiles } from "../shop/diffs.ts";
import type { PlantedMode } from "../shop/types.ts";
import type { FixCheckResult } from "./check.ts";
import { leftoversOf } from "./leftovers.ts";
import type { RefereeResult, RunName } from "./referee.ts";
import { BASELINE_LABEL, checkRows, claimOf, controlRow, FIX_CONTROL_IDS, NOT_PROVEN_FIX_TEXT, type FixBaseline, type FixControlRow, type FixResult, type PatchView } from "./types.ts";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// The diff from the bad deploy's file to the patched file: what the owner reviews and what the screen shows, line for line.
export function patchView(file: string, bad: string, patched: string): PatchView {
  const hunks = diffFiles("bad", "patched", bad, patched).map((h) => h.lines.map((l) => ({ kind: l.kind, text: l.text })));
  const count = (kind: "add" | "del") => hunks.reduce((n, h) => n + h.filter((l) => l.kind === kind).length, 0);
  return { file, hunks, added: count("add"), removed: count("del") };
}

// The four controls of one referee run. n: deliveries replayed in that control; for the PayPal control, the order outcomes compared.
export function controlsOf(r: RefereeResult): FixControlRow[] {
  const deliveries = (name: RunName) => r.runs.filter((v) => v.name === name).reduce((n, v) => n + v.got.statuses.length, 0);
  const outcomes = r.runs.filter((v) => v.name !== "tampered").length;
  const n: Record<(typeof FIX_CONTROL_IDS)[number], number> = { arrival_order: deliveries("real"), reversed: deliveries("reversed"), tampered: deliveries("tampered"), paypal_books: outcomes };
  const ok = { arrival_order: r.controls.real, reversed: r.controls.reversed, tampered: r.controls.tampered, paypal_books: r.controls.paypal };
  return FIX_CONTROL_IDS.map((id) => controlRow(id, ok[id], n[id]));
}

export const notRun = (): FixControlRow[] => FIX_CONTROL_IDS.map((id) => controlRow(id, false, 0));

export interface ResultParts {
  mode: PlantedMode;
  causeRequestHash: string;
  fixRequestHash: string;
  promptVersion: string;
  model: string;
  recordedAt: number;
  ranAt: number;
  basis: FixResult["basis"];
  file: string; // the bad deploy's file
  bad: string;
  good?: string; // the shop's last good handler: what the patched file is compared with for the leftovers (absent: the result carries none)
  checks: FixCheckResult;
  patched: string | undefined;
  referee?: RefereeResult; // absent when the checks failed: nothing was replayed
  signatureBaseline?: RefereeResult; // the patched file with its signature check removed, through the same controls
  orders: number;
}

export function buildResult(p: ResultParts): FixResult {
  const controls = p.referee && !p.referee.infra && !p.referee.codeFailure ? controlsOf(p.referee) : notRun();
  const proven = p.checks.ok && p.patched !== undefined && p.referee?.pass === true && !!p.signatureBaseline;
  const inputs = p.referee?.inputs ?? 0;
  const baseline: FixBaseline | null = proven && p.signatureBaseline ? { id: "skips_signature_check", label: BASELINE_LABEL, controls: controlsOf(p.signatureBaseline) } : null;
  return {
    mode: p.mode,
    causeRequestHash: p.causeRequestHash,
    fixRequestHash: p.fixRequestHash,
    promptVersion: p.promptVersion,
    model: p.model,
    source: "recording",
    basis: p.basis,
    recordedAt: p.recordedAt,
    ranAt: p.ranAt,
    verdict: proven ? "proven" : "not_proven",
    claim: proven ? claimOf(p.orders, inputs) : NOT_PROVEN_FIX_TEXT,
    orders: proven ? p.orders : 0,
    inputs: proven ? inputs : 0,
    patchSha256: p.patched !== undefined ? sha256(p.patched) : "",
    patch: proven && p.patched !== undefined ? patchView(p.file, p.bad, p.patched) : null,
    checks: checkRows(p.checks.rows),
    controls,
    baseline,
    ...(proven && p.good !== undefined && p.patched !== undefined ? { leftovers: leftoversOf(p.good, p.patched) } : {}),
  };
}
