// The reviewed patch proven again on the signed deliveries of one recorded session (record time): the session's orders become scenarios, the
// controls run in the sandbox child process, and the result says what happened on THIS session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSession } from "../gaps/scan.ts";
import { SHOP_WEBHOOK_ID } from "../shop/test-helpers.ts";
import type { PlantedMode } from "../shop/types.ts";
import { proveOnSession, type SessionProofDeps } from "./prove.ts";
import { sha256 } from "./result.ts";
import { scenariosFromScan } from "./scenarios.ts";
import { confirmedCause, GOOD, plantedWorld, provenFix } from "./test-helpers.ts";
import { claimOf } from "./types.ts";
import type { RecordedReplays } from "../cause/replay.ts";
import recorded from "../../fixtures/replay/recorded.json" with { type: "json" };

const RECORDED = recorded as unknown as RecordedReplays;

async function setup(mode: PlantedMode, rows = 2) {
  const world = await plantedWorld(mode, rows);
  const scan = await scanSession(world.w.deps(), world.sid, (await world.w.store.getSession(world.sid))!);
  const witness = { attempts: async (tid: string) => (world.stored.has(tid) ? [world.stored.get(tid)!] : []) };
  const { cause } = await confirmedCause(mode, RECORDED);
  const { result, patched } = await provenFix(mode, cause.requestHash);
  const deps: SessionProofDeps = { witness, webhookIdOf: () => SHOP_WEBHOOK_ID, verify: async (p) => world.pp.verify(p), goodText: GOOD, patchedText: () => patched };
  return { world, scan, witness, result, patched, deps };
}

test("a session's orders become scenarios: the deliveries the witness stored, in the order it received them, with PayPal's answer for the order", async () => {
  const { scan, witness } = await setup("ack_then_drop");
  const scenarios = await scenariosFromScan(scan, witness, () => SHOP_WEBHOOK_ID);
  assert.equal(scenarios.length, 2);
  for (const s of scenarios) {
    assert.equal(s.truth, "refunded");
    assert.deepEqual(s.deliveries.map((d) => JSON.parse(d.raw).event_type), ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED"]);
    assert.equal(s.deliveries[0].webhookId, SHOP_WEBHOOK_ID);
  }
});

test("an order the witness did not hear in full, or whose stored copy is gone, is left out", async () => {
  const { scan, witness } = await setup("ack_then_drop", 3);
  const [a, b, c] = scan.rows;
  a.events[1].d = null; // the refund was never heard
  const gone = b.events[0].d!.tid!;
  const lossy = { attempts: async (tid: string) => (tid === gone ? [] : witness.attempts(tid)) };
  const scenarios = await scenariosFromScan(scan, lossy, () => SHOP_WEBHOOK_ID);
  assert.deepEqual(scenarios.map((s) => s.capture), [c.captureId]);
  c.truth = null; // PayPal did not answer for it
  assert.deepEqual(await scenariosFromScan(scan, lossy, () => SHOP_WEBHOOK_ID), []);
});

for (const mode of ["ack_then_drop", "bad_body", "last_write_wins"] as PlantedMode[]) {
  test(`${mode}: the reviewed patch is proven again on the session's own deliveries, labelled replayed, with the same patch and checks`, async () => {
    const { scan, result, deps } = await setup(mode);
    const fresh = await proveOnSession(deps, { recorded: { ...result, basis: "recorded", ranAt: 1 }, scan });
    assert.ok(fresh);
    assert.equal(fresh.verdict, "proven");
    assert.equal(fresh.basis, "replayed");
    assert.ok(fresh.ranAt > 1);
    assert.equal(fresh.orders, 2);
    assert.equal(fresh.inputs, 12);
    assert.equal(fresh.claim, claimOf(2, 12));
    assert.ok(fresh.controls.every((c) => c.ok && c.n === 4));
    assert.equal(fresh.baseline!.controls.find((c) => c.id === "tampered")!.ok, false);
    assert.deepEqual([fresh.patch, fresh.checks, fresh.patchSha256, fresh.fixRequestHash, fresh.causeRequestHash], [result.patch, result.checks, result.patchSha256, result.fixRequestHash, result.causeRequestHash], "the patch and its checks are the recorded ones");
  });
}

test("nothing to prove it on, or a patched file that is not the reviewed one: null, and the recorded result stays", async () => {
  const { scan, result, deps } = await setup("ack_then_drop");
  assert.equal(await proveOnSession({ ...deps, patchedText: () => undefined }, { recorded: result, scan }), null);
  assert.equal(await proveOnSession({ ...deps, patchedText: () => `${deps.patchedText("ack_then_drop")}// edited after the review\n` }, { recorded: result, scan }), null);
  const bare = { ...scan, rows: scan.rows.map((r) => ({ ...r, events: r.events.map((e) => ({ ...e, d: null })) })) };
  assert.equal(await proveOnSession(deps, { recorded: result, scan: bare }), null);
});

test("PayPal cannot be asked: the proof throws (the caller keeps the recorded result), it does not report a failed fix", async () => {
  const { scan, result, deps } = await setup("ack_then_drop");
  await assert.rejects(() => proveOnSession({ ...deps, verify: async () => { throw new Error("timeout"); } }, { recorded: result, scan }), /PayPal could not be asked/);
});

test("a reviewed patch that fails a control on this session is reported as not proven, with no code", async () => {
  const { scan, result, deps } = await setup("last_write_wins");
  // a patch that parses and loads but books the late payment over the refund
  const stale = `${GOOD.replace("  if (current && rank(current.state) > rank(booking.state)) return { status: 200 };\n", "")}`;
  const fresh = await proveOnSession({ ...deps, patchedText: () => stale }, { recorded: { ...result, patchSha256: sha256(stale) }, scan });
  assert.ok(fresh);
  assert.equal(fresh.verdict, "not_proven");
  assert.equal(fresh.patch, null);
  assert.equal(fresh.baseline, null);
  assert.deepEqual(fresh.controls.map((c) => c.ok), [true, false, true, false]);
});
