// The contract every RunSnapshot has to obey (lib/ui/check.ts), run on the REAL recorded run (what the screens play back) and, separately, on the
// samples that stay for the gallery and for tests that need a snapshot the recording does not have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkScenario, checkSnapshot } from "./check.ts";
import { recordedScenario } from "../run/recorded.ts";
import { SAMPLE_EMPTY, SAMPLE_SCENARIOS, SAMPLE_SILENT } from "./samples.ts";
import { SCENARIOS } from "./source.ts";
import type { RunSnapshot } from "../run/snapshot.ts";

test("every real recorded scenario passes checkScenario: the five scenarios, four steps each", () => {
  assert.deepEqual(SCENARIOS.map((s) => s.id), ["refund_never_booked", "late_payment_overwrites", "signature_rejected", "resend_not_delivered", "cause_not_in_code"]);
  for (const sc of SCENARIOS) {
    assert.equal(sc.steps.length, 4, sc.id);
    assert.deepEqual(checkScenario(sc), [], sc.id);
  }
});

test("the screens play the real recording, not the samples: no capture id starts with SAMPLE", () => {
  for (const sc of SCENARIOS) for (const st of sc.steps) for (const o of st.session.orders) assert.doesNotMatch(o.captureId, /^SAMPLE_/, sc.id);
});

test("the first step of every real scenario has 2 gaps (R12: the first screen shows them)", () => {
  for (const sc of SCENARIOS) {
    assert.equal(sc.steps[0].scan!.summary.gaps, 2, sc.id);
    assert.equal(sc.steps[0].certificate!.stamp, "red", sc.id);
  }
});

// ---- the samples ------------------------------------------------------------------------------------------------------------------------

test("the sample scenarios obey the contract on every step, and the gallery samples too", () => {
  assert.equal(SAMPLE_SCENARIOS.length, 3);
  for (const sc of SAMPLE_SCENARIOS) {
    assert.equal(sc.steps.length, 3, sc.id);
    assert.deepEqual(checkScenario(sc), [], sc.id);
  }
  assert.deepEqual(checkSnapshot(SAMPLE_EMPTY), []);
  assert.deepEqual(checkSnapshot(SAMPLE_SILENT), []);
});

test("the samples cover all three stamp colors, and are marked as invented: their ids start with SAMPLE", () => {
  const stamps = new Set(SAMPLE_SCENARIOS.flatMap((s) => s.steps.map((x) => x.certificate!.stamp)));
  assert.deepEqual([...stamps].sort(), ["amber", "green", "red"]);
  for (const sc of SAMPLE_SCENARIOS) for (const st of sc.steps) for (const o of st.session.orders) assert.match(o.captureId, /^SAMPLE_/);
});

// ---- the check itself -------------------------------------------------------------------------------------------------------------------

const base = (): RunSnapshot => structuredClone(SCENARIOS[0].steps[0]);

test("the check catches a green stamp that the numbers do not support", () => {
  const s = base();
  s.certificate!.stamp = "green";
  assert.ok(checkSnapshot(s).some((v) => /stamp is green but the numbers say red/.test(v)));
});

test("the check catches a recorded run without a date, and a live run with one", () => {
  const a = base();
  a.recordedAt = null;
  assert.ok(checkSnapshot(a).some((v) => /no recording date/.test(v)));
  const b = { ...base(), mode: "LIVE" as const };
  assert.ok(checkSnapshot(b).some((v) => /LIVE carries a recording date/.test(v)));
});

test("the check catches a cause for a row that does not exist, and a healed ring on a row that is not tied", () => {
  const a = SCENARIOS[0].steps[1];
  const s = structuredClone(a);
  s.causes = structuredClone(SCENARIOS[0].steps[0].causes);
  s.causes[0].captureId = "NOT_A_ROW";
  assert.ok(checkSnapshot(s).some((v) => /matches no scan row/.test(v)));
  const t = structuredClone(a);
  t.scan!.rows.find((r) => r.status === "GAP")!.events.find((e) => e.finding)!.heal = { state: "healed", sends: 1 };
  assert.ok(checkSnapshot(t).some((v) => /healed ring but is GAP/.test(v)));
});

test("the check wants the certificate to say it is not signed", () => {
  const s = base();
  (s.certificate as unknown as { signed: boolean }).signed = true;
  assert.ok(checkSnapshot(s).some((v) => /not signed/.test(v)));
});

// ---- rows PayPal's own retry closed (lib/gaps/closure.ts) -------------------------------------------------------------------------------------

// The recording where order 1 was closed by PayPal's own retry (a 500, then a 200 on the same transmission id), and its last step: 3 tied, 2 of them healed.
const retry = (): RunSnapshot => structuredClone(recordedScenario("signature_rejected").steps[3]);

test("the recording with a row PayPal's retry closed is sound: the certificate counts one, and the check agrees", () => {
  const s = retry();
  assert.equal(s.certificate!.numbers.closedByPaypalRetry, 1);
  assert.equal(s.certificate!.numbers.healed, 2);
  assert.equal(s.certificate!.numbers.tied, 3);
  assert.deepEqual(checkSnapshot(s), []);
});

test("the check catches a certificate that does not count the row PayPal's retry closed, or counts more than the scan shows", () => {
  const missing = retry();
  delete missing.certificate!.numbers.closedByPaypalRetry;
  assert.ok(checkSnapshot(missing).some((v) => /says 0 tied rows were booked on PayPal's own retry but the scan shows 1/.test(v)));
  const more = retry();
  more.certificate!.numbers.closedByPaypalRetry = 2;
  assert.ok(checkSnapshot(more).some((v) => /says 2 tied rows .* the scan shows 1/.test(v)));
});

test("the check catches the number on a scan that has no such row", () => {
  const s = structuredClone(SCENARIOS[0].steps[3]);
  assert.deepEqual(checkSnapshot(s), []);
  s.certificate!.numbers.closedByPaypalRetry = 1;
  assert.ok(checkSnapshot(s).some((v) => /says 1 tied rows .* the scan shows 0/.test(v)));
});

test("a row that is no longer tied is not counted, so the number that still counts it is caught", () => {
  const s = retry();
  s.scan!.rows.find((r) => r.n === 1)!.status = "UNVERIFIED";
  assert.ok(checkSnapshot(s).some((v) => /says 1 tied rows .* the scan shows 0/.test(v)));
});

test("the check catches a resend that arrived on the same row: the row is the ring's, so the number counted it twice", () => {
  const s = retry();
  const ev = s.scan!.rows.find((r) => r.n === 1)!.events.find((e) => e.eid !== null)!;
  ev.heal = { state: "healed", sends: 1, sentAt: [ev.s![0].receivedAt! + 10_000], arrivedAt: ev.s![0].receivedAt! + 13_000 };
  assert.ok(checkSnapshot(s).some((v) => /says 1 tied rows .* the scan shows 0/.test(v)));
});

test("the check catches healed plus booked-on-PayPal's-retry above the tied rows", () => {
  const s = retry();
  s.certificate!.numbers.healed = 3; // 3 + 1 > 3
  assert.ok(checkSnapshot(s).some((v) => /healed plus booked-on-PayPal's-retry is more than the tied rows/.test(v)));
});
