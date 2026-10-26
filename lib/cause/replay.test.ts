// R25 / A25, offline: the real handler files run in-process on signed deliveries, good build against bad build. The stand-in for PayPal's
// verify endpoint is the one from the shop tests; it has the property the planted bugs depend on (the delivery is checked against
// the exact key order PayPal signed). The same engine runs against the real endpoint in scripts/s4-acceptance.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { completedEvent, fakePaypal, refundedEvent, SHOP_WEBHOOK_ID, type SignedDelivery } from "../shop/test-helpers.ts";
import type { PlantedMode } from "../shop/types.ts";
import { REPLAY_WINDOW_MS, replayNow, replayOrRecorded, replaySentence, type ReplayCase, type ReplayDelivery, type VerifyFn } from "./replay.ts";

const delivery = (d: SignedDelivery, time?: string): ReplayDelivery => ({
  raw: d.raw,
  headers: { transmissionId: d.tid, transmissionTime: time ?? d.headers["paypal-transmission-time"], transmissionSig: d.headers["paypal-transmission-sig"], certUrl: d.headers["paypal-cert-url"], authAlgo: d.headers["paypal-auth-algo"] },
  webhookId: SHOP_WEBHOOK_ID,
});

function world(mode: PlantedMode, time?: string) {
  const paypal = fakePaypal();
  const capture = `CAPTURE${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
  const completed = delivery(paypal.sign(completedEvent(capture)), time);
  const refunded = delivery(paypal.sign(refundedEvent(capture, `REFUND${capture.slice(7)}`)), time);
  // The real arrival order of the last-write-wins bug is the refund first and a late payment after it; the others arrive payment then refund.
  const c: ReplayCase = { mode, deliveries: mode === "last_write_wins" ? [refunded, completed] : [completed, refunded] };
  return { c, verify: paypal.verify as VerifyFn };
}

const MODES: PlantedMode[] = ["bad_body", "ack_then_drop", "last_write_wins"];

test("A25: all 3 modes split good from bad as the bug predicts, 3 runs each (9/9)", async () => {
  let confirmed = 0;
  for (let run = 0; run < 3; run++) {
    for (const mode of MODES) {
      const { c, verify } = world(mode);
      const r = await replayNow(c, verify);
      assert.equal(r.verdict, "CONFIRMED BY REPLAY", `${mode} run ${run}`);
      assert.equal(r.basis, "replayed");
      confirmed++;
      if (mode === "bad_body") {
        assert.deepEqual(r.good, { statuses: [200, 200], book: "refunded" });
        assert.deepEqual(r.bad, { statuses: [401, 401], book: null }); // 401 against 200, books unchanged against changed
      }
      if (mode === "ack_then_drop") {
        assert.deepEqual(r.good, { statuses: [200, 200], book: "refunded" });
        assert.deepEqual(r.bad, { statuses: [200, 200], book: null }); // both 200: only the books tell them apart
      }
      if (mode === "last_write_wins") {
        assert.deepEqual(r.good, { statuses: [200, 200], book: "refunded" }); // REFUNDED then COMPLETED: the refund survives
        assert.deepEqual(r.bad, { statuses: [200, 200], book: "paid" }); // the late payment overwrites it
      }
    }
  }
  assert.equal(confirmed, 9);
});

test("the replay reads the real arrival order: the same two events in the other order do not separate last-write-wins", async () => {
  const { c, verify } = world("last_write_wins");
  const flipped: ReplayCase = { ...c, deliveries: [...c.deliveries].reverse() }; // payment, then refund: both builds end refunded
  const r = await replayNow(flipped, verify);
  assert.equal(r.verdict, "NOT CONFIRMED");
  assert.equal(r.reason, "expectation_not_met");
  assert.equal(r.bad.book, "refunded");
});

test("a stale or wrong signature does not confirm anything: the good build is rejected too", async () => {
  const { c } = world("bad_body");
  const r = await replayNow(c, async () => "FAILURE");
  assert.equal(r.verdict, "NOT CONFIRMED");
  assert.deepEqual(r.good.statuses, [401, 401]);
});

test("an event the shop does not book separates nothing: NOT CONFIRMED", async () => {
  const { c, verify } = world("ack_then_drop");
  const noise: ReplayCase = { ...c, deliveries: [{ ...c.deliveries[0], raw: JSON.stringify({ id: "WH-X", event_type: "CHECKOUT.ORDER.APPROVED", resource: {} }) }] };
  assert.equal((await replayNow(noise, async () => "SUCCESS")).verdict, "NOT CONFIRMED");
  assert.ok(verify);
});

test("when PayPal's verify cannot be reached the replay says so and does not claim a result", async () => {
  const { c } = world("bad_body");
  const r = await replayNow(c, async () => {
    throw new Error("timeout");
  });
  assert.deepEqual([r.verdict, r.reason, r.good.statuses.length], ["NOT CONFIRMED", "verify_unavailable", 0]);
});

test("outside the replay window the shown result is the recorded one, labelled recorded (100%); with none it is NOT CONFIRMED", async () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const old = new Date(now - REPLAY_WINDOW_MS - 60_000).toISOString();
  const fresh = new Date(now - 5 * 60_000).toISOString();
  let verified = 0;
  for (const mode of MODES) {
    const live = world(mode, fresh);
    const recordedResult = await replayNow(live.c, live.verify, () => now - 3 * 3600_000);
    const stale = world(mode, old);
    const counting: VerifyFn = async (p) => (verified++, stale.verify(p));
    const shown = await replayOrRecorded(stale.c, counting, { [mode]: recordedResult }, () => now);
    assert.equal(shown.basis, "recorded", mode);
    assert.equal(shown.verdict, "CONFIRMED BY REPLAY");
    assert.equal(shown.ranAt, now - 3 * 3600_000, "the time shown is when it was recorded");
    assert.match(replaySentence(shown), /recorded result \(2026-10-20 09:00 UTC\)/);
    const none = await replayOrRecorded(stale.c, counting, {}, () => now);
    assert.deepEqual([none.verdict, none.basis, none.reason], ["NOT CONFIRMED", "none", "outside_window_no_recording"]);
    const inside = await replayOrRecorded(live.c, live.verify, { [mode]: recordedResult }, () => now);
    assert.equal(inside.basis, "replayed", "inside the window it is replayed for real");
  }
  assert.equal(verified, 0, "outside the window PayPal's verify is not called");
});

test("a replay says how old it is, from its own time: just now, seconds, minutes, then the date; a result kept for a later poll or played back from a recording is never 'just now'", async () => {
  const { c, verify } = world("bad_body");
  const r = await replayNow(c, verify, () => Date.parse("2026-10-19T12:29:05Z"));
  const at = (ms: number) => replaySentence(r, Date.parse("2026-10-19T12:29:05Z") + ms);
  assert.match(at(0), /\(replayed just now\)$/);
  assert.match(at(9_000), /\(replayed just now\)$/);
  assert.match(at(30_000), /\(replayed 30 s ago\)$/);
  assert.match(at(3 * 60_000), /\(replayed 3 min ago\)$/);
  assert.match(at(89 * 60_000), /\(replayed 89 min ago\)$/);
  assert.match(at(95 * 60_000), /\(replayed on Oct 19, 12:29 UTC\)$/);
  assert.match(at(3 * 24 * 3600_000), /\(replayed on Oct 19, 12:29 UTC\)$/, "days later: the date, not 'just now'");
  assert.match(at(-5_000), /\(replayed just now\)$/, "a clock a little behind the replay's is not a negative age");
  // a recorded result keeps its own wording, and the default `now` is the real one
  assert.match(replaySentence({ ...r, basis: "recorded" }, 0), /\(recorded result \(2026-10-19 12:29 UTC\)\)$/);
  assert.match(replaySentence({ ...r, ranAt: Date.now() - 5 * 60_000 }), /\(replayed 5 min ago\)$/);
});

test("the sentence under the chip is built from fixed words and numbers", async () => {
  const { c, verify } = world("bad_body");
  const s = replaySentence(await replayNow(c, verify));
  assert.match(s, /^Good build: 200\/200, books refunded\. Bad build: 401\/401, books unchanged\. \(replayed just now\)$/);
});
