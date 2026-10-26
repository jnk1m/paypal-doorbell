// The step titles of the dispute run say what the step's own snapshot shows, in fixed words and its numbers, and no more.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../cause/test-helpers.ts";
import type { RecordedReplays } from "../cause/replay.ts";
import { DISPUTE_CREATED } from "../gaps/disputes.ts";
import { gapWorld } from "../gaps/test-world.ts";
import { computeDiffs } from "../shop/diffs.ts";
import { buildLiveSnapshot } from "./build.ts";
import type { RunSnapshot } from "./snapshot.ts";
import { disputeTitle } from "./titles.ts";

const BUNDLE = computeDiffs(ROOT);
const RECORDED = JSON.parse(readFileSync(join(ROOT, "fixtures/replay/recorded.json"), "utf8")) as RecordedReplays;
const FORBIDDEN = ["complete", "nothing missing", "all tied", "every", "no gaps", "all clear", "fully"];
const hits = (text: string): string[] => FORBIDDEN.filter((w) => new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`, "i").test(text));

type World = ReturnType<typeof gapWorld>;
const snap = async (w: World, sid: string): Promise<RunSnapshot> => buildLiveSnapshot({ scan: w.deps({ disputes: { reads: w.disputeReads } }), bundle: BUNDLE, recordedReplays: RECORDED, log: () => undefined }, sid, (await w.store.getSession(sid))!);

async function stages() {
  const w = gapWorld();
  const sid = await w.session();
  const orders = [await w.order(sid, { book: "paid" }), await w.order(sid, { book: "paid" }), await w.order(sid, { book: "paid" })];
  const target = orders[1].captureId;
  const before = await snap(w, sid);
  w.clock.now += 90_000;
  w.dispute(target, { ageMs: 50_000, status: "OPEN" });
  const listed = await snap(w, sid);
  w.clock.now += 130_000;
  w.paypal.disputes.set(target, [{ ...w.paypal.disputes.get(target)![0], status: "WAITING_FOR_SELLER_RESPONSE", sellerResponseDueAt: Date.parse("2026-10-31T03:59:59.000Z") }]);
  w.paypal.captures.set(target, "PENDING");
  const due = await snap(w, sid);
  return { w, sid, target, before, listed, due };
}

test("the four titles, from the four snapshots of a dispute run", async () => {
  const { target, before, listed, due } = await stages();
  assert.equal(disputeTitle("before", before, target), "3 of 3 orders are tied: the books agree with PayPal.");
  assert.equal(disputeTitle("listed", listed, target), "PayPal lists a $48.00 dispute on order #2. The shop's books have none, and no webhook of this app subscribes to dispute events.");
  assert.equal(disputeTitle("due", due, target), "The capture now shows PENDING at PayPal. PayPal's response-due date is 2026-10-31 03:59 UTC, the one our Sandbox test call asked for.");
  assert.equal(disputeTitle("ring", due, target), "Ring again: nothing was sent. No webhook of this app subscribes to dispute events, so Doorbell has no event to ask PayPal to send again.");
  for (const t of [before, listed, due].flatMap((s) => (["before", "listed", "due", "ring"] as const).map((k) => disputeTitle(k, s, target)))) assert.deepEqual(hits(t), [], t);
});

test("the due step says so when PayPal has not set a date yet or the capture has not changed; an unknown status is not repeated", async () => {
  const { target, listed, due } = await stages();
  assert.equal(disputeTitle("due", listed, target), "The capture still shows COMPLETED at PayPal. PayPal has not set a response-due date yet.");
  const odd = structuredClone(due);
  odd.scan!.rows.find((r) => r.captureId === target)!.paypalStatus = "MARKER-INJECTED";
  assert.equal(disputeTitle("due", odd, target), "The capture shows another status at PayPal. PayPal's response-due date is 2026-10-31 03:59 UTC, the one our Sandbox test call asked for.");
});

test("another webhook of the app subscribes and the shop's does not: the title names the shop's webhook, not the app", async () => {
  const w = gapWorld();
  const sid = await w.session();
  const o = await w.order(sid, { book: "paid" });
  w.paypal.webhooks[1].types.push(DISPUTE_CREATED);
  w.clock.now += 90_000;
  w.dispute(o.captureId, { ageMs: 50_000 });
  const s = await snap(w, sid);
  assert.equal(disputeTitle("listed", s, o.captureId), "PayPal lists a $48.00 dispute on order #1. The shop's books have none, and the shop's webhook is not subscribed to dispute events.");
  assert.equal(disputeTitle("ring", s, o.captureId), "Ring again: nothing was sent. The shop's webhook is not subscribed to dispute events, so Doorbell has no event to ask PayPal to send again.");
});

test("a snapshot with no dispute on the order never gets a title that claims one; one order reads in the singular", async () => {
  const w = gapWorld();
  const sid = await w.session();
  const o = await w.order(sid, { book: "paid" });
  const s = await snap(w, sid);
  assert.equal(disputeTitle("listed", s, o.captureId), "No dispute is listed on order #1 yet.");
  assert.equal(disputeTitle("before", s, o.captureId), "1 of 1 order is tied: the books agree with PayPal.");
  assert.equal(disputeTitle("ring", s, "NOT-AN-ORDER-0001"), "No dispute is listed on an order of this session yet.");
});
