// Shared by the fix tests: the planted deploys as the product reads them (the same input the cause step gets), a target for any other pair of
// handler texts, orders made of fake-signed events with the shop tests' stand-in for PayPal's verify endpoint, and a recorded, confirmed cause
// with a fix proven on that stand-in. Everything is offline.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnose } from "../cause/cause.ts";
import { SYMPTOM_CLASSES, type SymptomClass } from "../cause/categories.ts";
import { confirmationOf } from "../cause/confirm.ts";
import { diffFromShop } from "../cause/diff.ts";
import { normalizeSource } from "../cause/hygiene.ts";
import type { CauseInput } from "../cause/prompt.ts";
import type { RecordedReplays } from "../cause/replay.ts";
import { MODEL_ID } from "../core/llm.ts";
import { deployInput } from "../run/deploy-input.ts";
import { CAUSE_RECORDINGS_DIR } from "../run/recordings.ts";
import type { GapCause } from "../run/snapshot.ts";
import { computeDiffs, diffFiles, type ModeDiff } from "../shop/diffs.ts";
import { completedEvent, fakePaypal, refundedEvent, SHOP_WEBHOOK_ID } from "../shop/test-helpers.ts";
import type { BrokenMode, PlantedMode } from "../shop/types.ts";
import { gapWorld } from "../gaps/test-world.ts";
import { COMPLETED, REFUNDED } from "../shop/events.ts";
import type { AttemptEntry } from "../witness/store.ts";
import { deleteVerify } from "./baselines.ts";
import { checkFix, fixTarget, type FixTarget } from "./check.ts";
import type { Edit } from "./edits.ts";
import { CachedVerifier, Referee, type Delivery, type Scenario } from "./referee.ts";
import { buildResult } from "./result.ts";
import type { FixResult } from "./types.ts";

// Not imported from lib/cause/test-helpers.ts: that file is left out of the deployed upload (.vercelignore) and this one is not.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const text = (rel: string): string => readFileSync(`${ROOT}/${rel}`, "utf8");
export const GOOD = text("handlers/good.ts");
export const FILE_OF: Record<PlantedMode, string> = { bad_body: "handlers/bad-body.ts", ack_then_drop: "handlers/ack-drop.ts", last_write_wins: "handlers/last-write-wins.ts" };

// The planted deploy as the product reads it: lib/run/deploy-input.ts over the build-time diffs.
export function plantedTarget(mode: PlantedMode): FixTarget {
  const input = deployInput(mode, computeDiffs(ROOT), "other");
  return fixTarget(input.diff, input.files[0].text);
}

// Any handler text against the last good one, the way a cause input is made from a diff of the shop.
export function targetOf(good: string, bad: string, badPath: string): FixTarget {
  const from = "handlers/good.ts";
  const d: ModeDiff = { mode: "bad_body", from, to: badPath, hunks: diffFiles(from, badPath, good, bad) };
  const norm = (s: string) => normalizeSource(s).text;
  const normalized = { ...d, hunks: d.hunks.map((h) => ({ ...h, lines: h.lines.map((l) => ({ ...l, text: norm(l.text) })) })) };
  return fixTarget(diffFromShop(normalized, { before: { [from]: norm(good) }, after: { [badPath]: norm(bad) } }), norm(bad));
}

export const E = (op: Edit["op"], id: string, ...lines: string[]): Edit => ({ op, id, lines });

// The id of the changed line with this text.
export function idOf(t: FixTarget, kind: "add" | "del", needle: string): string {
  const hit = [...t.index.values()].find((l) => l.kind === kind && l.text.includes(needle));
  if (!hit) throw new Error(`no ${kind} line with ${needle}`);
  return hit.id;
}

// The fix a careful developer would write for each planted bug, as edits, with the ids the cause step cited.
export function carefulFix(mode: PlantedMode, t: FixTarget): { cited: string[]; edits: Edit[] } {
  const dels = [...t.index.values()].filter((l) => l.kind === "del").map((l) => l.id);
  if (mode === "bad_body") {
    const id = idOf(t, "add", "canonical(JSON.parse");
    return { cited: [id], edits: [E("replace", id, "  const event = JSON.parse(ctx.rawBody);")] };
  }
  if (mode === "ack_then_drop") {
    const push = idOf(t, "add", "queue.push(event)");
    return { cited: [idOf(t, "del", "ctx.books.set"), push], edits: [...dels.map((id) => E("restore", id)), E("delete", push)] };
  }
  // The import line was changed too, but the cause cited only the guard: the import is added back as a second line, the changed one stays.
  const imp = idOf(t, "del", "import { bookingOf, rank }");
  const guard = dels.filter((id) => id !== imp);
  return { cited: [idOf(t, "del", "ctx.books.get"), idOf(t, "del", "rank(current.state)")], edits: [E("insert_after", idOf(t, "add", "import { bookingOf }"), 'import { rank } from "../lib/shop/events.ts";'), ...guard.map((id) => E("restore", id))] };
}

// Orders of real-looking events; PayPal's stand-in accepts exactly the bodies it signed.
export function world(n = 2) {
  const paypal = fakePaypal();
  const scenarios: Scenario[] = [];
  for (let i = 0; i < n; i++) {
    const capture = `CAPTURE${i}ABCDEFG`;
    const sign = (e: { id: string }): Delivery => {
      const d = paypal.sign(e);
      return { raw: d.raw, webhookId: SHOP_WEBHOOK_ID, headers: { transmissionId: d.tid, transmissionTime: d.headers["paypal-transmission-time"], transmissionSig: d.headers["paypal-transmission-sig"], certUrl: d.headers["paypal-cert-url"], authAlgo: d.headers["paypal-auth-algo"] } };
    };
    scenarios.push({ capture, truth: "refunded", deliveries: [sign(completedEvent(capture)), sign(refundedEvent(capture, `REFUND${i}ABCDEFG`))] });
  }
  return { paypal, scenarios };
}

// The recorded cause of a planted mode (whichever symptom class it was recorded for), the recorded replay, and the chip they make together.
export async function confirmedCause(mode: PlantedMode, recorded: RecordedReplays): Promise<Pick<GapCause, "mode" | "cause" | "replay" | "confirmation"> & { cause: Extract<GapCause["cause"], { status: "proposed" }>; input: CauseInput; symptom: SymptomClass }> {
  const bundle = computeDiffs(ROOT);
  for (const symptom of SYMPTOM_CLASSES) {
    const input = deployInput(mode, bundle, symptom);
    const cause = await diagnose(input, { mode: "replay", onMiss: "none", dir: CAUSE_RECORDINGS_DIR, log: () => undefined });
    if (cause.status !== "proposed") continue;
    const replay = recorded[mode]!;
    return { mode, cause, replay, confirmation: confirmationOf(cause, replay), input, symptom };
  }
  throw new Error(`no recorded cause for ${mode}`);
}

// A fix proven on the stand-in world with the careful edits of this file, as the pipeline would build its result.
export async function provenFix(mode: PlantedMode, causeRequestHash: string): Promise<{ result: FixResult; patched: string }> {
  const t = plantedTarget(mode);
  const fix = carefulFix(mode, t);
  const checked = checkFix(t, new Set(fix.cited), fix.edits);
  const w = world();
  const ref = new Referee(w.scenarios, GOOD, new CachedVerifier(w.paypal.verify));
  await ref.prepare();
  const patched = checked.patched!;
  const result = buildResult({
    mode,
    causeRequestHash,
    fixRequestHash: "f".repeat(64),
    promptVersion: "fix-v1",
    model: MODEL_ID,
    recordedAt: Date.UTC(2026, 9, 20, 9, 0, 0),
    ranAt: Date.UTC(2026, 9, 20, 9, 5, 0),
    basis: "replayed",
    file: FILE_OF[mode],
    bad: t.bad,
    good: GOOD,
    checks: checked,
    patched,
    referee: await ref.judge(patched),
    signatureBaseline: await ref.judge(deleteVerify(patched)),
    orders: ref.scenarioCount,
  });
  return { result, patched };
}

// A session whose shop answered the refund the way the planted mode does, with both events heard by the witness (signed, stored).
export async function plantedWorld(mode: BrokenMode, rows = 2) {
  const w = gapWorld();
  const pp = fakePaypal();
  const sid = await w.session(mode);
  const stored = new Map<string, AttemptEntry>();
  const store = (d: ReturnType<typeof pp.sign>, type: string, eid: string): void => {
    stored.set(d.tid, { v: 1, tid: d.tid, slot: "D", at: Date.now(), st: "ok", h: { time: d.headers["paypal-transmission-time"], sig: d.headers["paypal-transmission-sig"], algo: d.headers["paypal-auth-algo"], cert: d.headers["paypal-cert-url"] }, eid, type, raw: d.raw, sha: "x", len: d.raw.length });
  };
  for (let i = 0; i < rows; i++) {
    const row = await w.order(sid, { refund: true, book: "paid", eventsListed: true });
    const paid = pp.sign(completedEvent(row.captureId, "48.00", row.paidEid));
    const refunded = pp.sign(refundedEvent(row.captureId, row.refundId, "48.00", row.refundEid));
    store(paid, COMPLETED, row.paidEid);
    store(refunded, REFUNDED, row.refundEid);
    await w.heard({ eid: row.paidEid, tid: paid.tid, type: COMPLETED, resourceId: row.captureId, at: row.at + 2_000 });
    await w.heard({ eid: row.refundEid, tid: refunded.tid, type: REFUNDED, resourceId: row.refundId, at: row.at + 12_000 });
    await w.deliver({ eid: row.paidEid, tid: paid.tid, type: COMPLETED, resourceId: row.captureId, status: 200, at: row.at + 2_000 });
    const answers = mode === "bad_body" || mode === "wrong_webhook_id_setting" ? [401, 401, 401] : [200];
    for (const [k, status] of answers.entries()) await w.deliver({ eid: row.refundEid, tid: refunded.tid, type: REFUNDED, resourceId: row.refundId, status, at: row.at + 12_000 + k * 30_000 });
  }
  w.clock.now += 10 * 60_000;
  return { w, pp, sid, stored };
}
