// The rules a fix result must obey for a screen to tell the truth about it (the fix part of checkSnapshot, lib/ui/check.ts). Pure; returns the
// violations as sentences, [] when the cause's fix is sound.
import type { GapCause } from "../run/snapshot.ts";
import { claimOf, FIX_CHECK_IDS, FIX_CONTROL_IDS, NOT_PROVEN_FIX_TEXT } from "./types.ts";

const PLAIN = /^[\x20-\x7e]*$/;

export function fixViolations(c: GapCause): string[] {
  const f = c.fix;
  if (f === undefined || f === null) return [];
  const bad: string[] = [];
  const at = `fix for ${c.captureId}`;

  // Only next to a cause that is proposed AND confirmed by the replay: nothing for a cause that is not proven or not diagnosed.
  if (c.cause.status !== "proposed") bad.push(`${at}: the cause is ${c.cause.status}, a fix is only for a proposed cause`);
  else if (f.causeRequestHash !== c.cause.requestHash) bad.push(`${at}: it answers another cause (${f.causeRequestHash.slice(0, 8)}), not this one`);
  if (c.confirmation?.confirmed !== true || c.replay?.verdict !== "CONFIRMED BY REPLAY") bad.push(`${at}: the cause is not confirmed by the replay`);
  if (f.mode !== c.mode) bad.push(`${at}: it is for mode ${f.mode}, the cause is for ${c.mode}`);
  if (f.source !== "recording") bad.push(`${at}: its source is ${String(f.source)}, a patch comes from a recording`);
  if (f.model === "" || f.promptVersion === "" || f.fixRequestHash === "") bad.push(`${at}: it does not say which model, prompt and recording it came from`);
  if (f.basis !== "replayed" && f.basis !== "recorded") bad.push(`${at}: basis ${String(f.basis)}`);

  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).join(",");
  if (ids(f.checks) !== FIX_CHECK_IDS.join(",")) bad.push(`${at}: the checks are ${ids(f.checks) || "missing"}`);
  if (ids(f.controls) !== FIX_CONTROL_IDS.join(",")) bad.push(`${at}: the controls are ${ids(f.controls) || "missing"}`);

  const allChecks = f.checks.every((r) => r.ok);
  const allControls = f.controls.every((r) => r.ok && r.n > 0);
  if (f.verdict === "proven") {
    if (!allChecks) bad.push(`${at}: proven, but a check failed`);
    if (!allControls) bad.push(`${at}: proven, but a control failed or was not run`);
    if (!f.patch) bad.push(`${at}: proven, but there is no patch to show`);
    if (!f.baseline) bad.push(`${at}: proven, but the signature-check baseline is missing`);
    else {
      const tampered = f.baseline.controls.find((r) => r.id === "tampered");
      const others = f.baseline.controls.filter((r) => r.id !== "tampered");
      if (!tampered || tampered.ok || tampered.n === 0) bad.push(`${at}: the tampered control did not catch the patch without its signature check`);
      if (!others.every((r) => r.ok)) bad.push(`${at}: the baseline must pass the replay of real events, otherwise it shows nothing`);
    }
    if (f.inputs <= 0 || f.orders <= 0) bad.push(`${at}: proven on ${f.inputs} inputs`);
    if (f.claim !== claimOf(f.orders, f.inputs)) bad.push(`${at}: the claim is not the fixed sentence for ${f.orders} orders and ${f.inputs} inputs`);
    if (f.patchSha256.length !== 64) bad.push(`${at}: no hash of the reviewed patch`);
  } else {
    // A fix that was not proven shows no code: model output reaches a screen only as a diff after every check passed.
    if (f.patch !== null) bad.push(`${at}: not proven, but it carries a patch`);
    if (f.baseline !== null) bad.push(`${at}: not proven, but it carries a baseline`);
    if (f.claim !== NOT_PROVEN_FIX_TEXT) bad.push(`${at}: not proven, but the claim says "${f.claim.slice(0, 40)}"`);
  }

  // What the patch leaves behind is read out of the patched file by code; a screen prints it in fixed words with only a name and counts, so each of
  // them must be what leftovers.ts can make: a known kind, an identifier for a name, whole numbers for a count.
  if (f.leftovers !== undefined) {
    if (f.verdict !== "proven") bad.push(`${at}: not proven, but it lists leftovers`);
    const count = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n >= 0;
    for (const l of f.leftovers) {
      const ok =
        (l.kind === "comment" && count(l.lines) && l.lines > 0) ||
        (l.kind === "unused" && /^[A-Za-z_$][\w$]{0,59}$/.test(l.name) && (l.declares === "function" || l.declares === "value")) ||
        l.kind === "imports" ||
        (l.kind === "other" && count(l.added) && count(l.removed) && l.added + l.removed > 0);
      if (!ok) bad.push(`${at}: a leftover is not one that leftovers.ts makes (${JSON.stringify(l).slice(0, 60)})`);
    }
  }

  for (const hunk of f.patch?.hunks ?? []) {
    for (const l of hunk) if (!PLAIN.test(l.text) || l.text.length > 200) bad.push(`${at}: a patch line is not plain ASCII or is longer than 200 characters`);
  }
  return bad;
}
