// R26 / A26: the witness is compared with PayPal's own event list. The F6 fixture is real: webhook E, registered a moment before 7 orders,
// got 3 of the 7 payment events its subscription covers; the other 4 were listed by PayPal and never delivered to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gapWorld } from "../gaps/test-world.ts";
import { scanSession } from "../gaps/scan.ts";
import { buildView } from "../shop/view.ts";
import { COMPLETED } from "../shop/events.ts";
import { heartbeatOf, heartbeatOfScan, MISSED_GRACE_MS, SILENT_AFTER_MS, witnessMisses, type ListedForHeartbeat } from "./heartbeat.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
interface WitnessGapFixture {
  source: string;
  witness: { slot: string; subscribedTypes: string[]; registeredAt: number };
  checkedAt: number;
  listed: (ListedForHeartbeat & { listLagS: number })[];
  heard: { eid: string; tid: string; at: number }[];
  probeTable: Record<string, string>;
  expectedMissed: string[];
}
const fixture = JSON.parse(readFileSync(join(ROOT, "fixtures/probe/witness-gap.json"), "utf8")) as WitnessGapFixture;

test("A26: on the real F6 probe log the heartbeat shows the 4 events PayPal listed and webhook E never heard: 4 of 4", () => {
  // The fixture is data from the probe: the list as PayPal showed it, and what E received. Nothing in it says which events were missed.
  assert.equal(fixture.listed.length, 14, "7 payments and 7 refunds were listed for the 7 orders");
  const input = { now: fixture.checkedAt, listed: fixture.listed, heard: fixture.heard.map((h) => h.eid), lastDeliveryAt: Math.max(...fixture.heard.map((h) => h.at)), subscribedTypes: fixture.witness.subscribedTypes };
  const { missed } = witnessMisses(input);
  // The probe's own table (which orders E got the payment event of) is the independent answer: E+5, E+35, E+125, E+185 were not delivered.
  const probeMissed = Object.entries(fixture.probeTable).filter(([, got]) => got !== "Y").map(([label]) => label);
  assert.deepEqual(probeMissed, ["E+5s", "E+35s", "E+125s", "E+185s"]);
  assert.equal(missed.length, 4, "4 shown");
  assert.deepEqual(missed.map((m) => m.eid).sort(), [...fixture.expectedMissed].sort(), "and they are the 4 the probe found");
  const hb = heartbeatOf(input);
  assert.equal(hb.state, "missed");
  assert.equal(hb.listedMissedByWitness, 4);
  assert.match(hb.text, /events list shows 4 the witness never heard/);
  assert.equal(`${hb.listedMissedByWitness} of ${probeMissed.length}`, "4 of 4", "A26: 4 of 4");
});

test("A26: the 3 events E did hear are not shown as missed, the refunds E never subscribed to are not either, and the fixture's list is not changed by the check", () => {
  const before = JSON.stringify(fixture.listed);
  const { missed } = witnessMisses({ now: fixture.checkedAt, listed: fixture.listed, heard: fixture.heard.map((h) => h.eid), subscribedTypes: fixture.witness.subscribedTypes });
  const ids = new Set(missed.map((m) => m.eid));
  for (const h of fixture.heard) assert.ok(!ids.has(h.eid), h.eid);
  assert.ok(missed.every((m) => m.type === COMPLETED), "only the type E subscribed to");
  // Without the subscription the 7 refunds would be counted as well: 4 + 7 = 11. The subscription is what makes it 4.
  assert.equal(witnessMisses({ now: fixture.checkedAt, listed: fixture.listed, heard: fixture.heard.map((h) => h.eid) }).missed.length, 11);
  assert.equal(JSON.stringify(fixture.listed), before);
});

const NOW = 1_800_000_000_000;
const listedAt = (age: number, eid = "WH-1"): ListedForHeartbeat => ({ eid, type: COMPLETED, createTime: NOW - age });

test("states: ok with a recent delivery and nothing missed; the text names how long ago", () => {
  const hb = heartbeatOf({ now: NOW, listed: [listedAt(60 * 60_000)], heard: ["WH-1"], lastDeliveryAt: NOW - 12_000 });
  assert.deepEqual(hb, { lastDeliveryAt: NOW - 12_000, listedMissedByWitness: 0, state: "ok", text: "Witness: last delivery 12 s ago · events list shows 0 the witness missed" });
  assert.match(heartbeatOf({ now: NOW, listed: [], heard: [], lastDeliveryAt: NOW - 5 * 60_000 }).text, /last delivery 5 min ago/);
  assert.match(heartbeatOf({ now: NOW, listed: [], heard: [], lastDeliveryAt: NOW - 25 * 60_000 }).text, /last delivery 25 min ago/);
});

test("silent: over 30 minutes since the last delivery (or none ever) is 'nothing to compare', and the text says that silence is not health", () => {
  const old = heartbeatOf({ now: NOW, listed: [], heard: [], lastDeliveryAt: NOW - SILENT_AFTER_MS - 1 });
  assert.equal(old.state, "silent");
  assert.match(old.text, /last delivery 30 min ago · silence is not health: nothing to compare/);
  assert.equal(heartbeatOf({ now: NOW, listed: [], heard: [], lastDeliveryAt: NOW - SILENT_AFTER_MS }).state, "ok", "30 minutes exactly is not over 30");
  const never = heartbeatOf({ now: NOW, listed: [], heard: [], lastDeliveryAt: null });
  assert.equal(never.state, "silent");
  assert.equal(never.lastDeliveryAt, null);
  assert.match(never.text, /no delivery heard yet · silence is not health/);
  assert.match(heartbeatOf({ now: NOW, listed: [], heard: [], lastDeliveryAt: NOW - 3 * 3_600_000 }).text, /last delivery 3 h ago/);
});

test("a list that could not be read is 'nothing to compare', never 'ok'; the count is null, not 0", () => {
  const hb = heartbeatOf({ now: NOW, listed: null, heard: ["WH-1"], lastDeliveryAt: NOW - 1000 });
  assert.equal(hb.state, "silent");
  assert.equal(hb.listedMissedByWitness, null);
  assert.match(hb.text, /events list could not be read: nothing to compare/);
});

test("missed wins over silent: a witness that went quiet while PayPal listed events it never heard is shown as missed", () => {
  const hb = heartbeatOf({ now: NOW, listed: [listedAt(40 * 60_000, "WH-A"), listedAt(41 * 60_000, "WH-B")], heard: [], lastDeliveryAt: NOW - 2 * 3_600_000 });
  assert.equal(hb.state, "missed");
  assert.equal(hb.listedMissedByWitness, 2);
  assert.match(hb.text, /last delivery 2 h ago · events list shows 2 the witness never heard/);
});

test("a witness subscribed to every event is listed by PayPal as the single type \"*\": it hears every type, so an unheard event of any type is missed, not skipped as 'not subscribed'", () => {
  const listed: ListedForHeartbeat[] = [listedAt(60 * 60_000, "WH-PAID"), { eid: "WH-REFUND", type: "PAYMENT.CAPTURE.REFUNDED", createTime: NOW - 60 * 60_000 }, { eid: "WH-DISPUTE", type: "CUSTOMER.DISPUTE.CREATED", createTime: NOW - 60 * 60_000 }];
  const missedBy = (subscribedTypes: string[]) => witnessMisses({ now: NOW, listed, heard: ["WH-PAID"], subscribedTypes }).missed.map((m) => m.eid);
  assert.deepEqual(missedBy(["*"]), ["WH-REFUND", "WH-DISPUTE"], "PayPal sends the all-events webhook everything, so both unheard events are misses");
  assert.deepEqual(missedBy(["PAYMENT.CAPTURE.COMPLETED"]), [], "a named list still filters (PayPal accepts no prefix pattern such as PAYMENT.CAPTURE.*: it answers VALIDATION_ERROR)");
  assert.deepEqual(missedBy(["PAYMENT.CAPTURE.REFUNDED", "*"]), ["WH-REFUND", "WH-DISPUTE"], "the wildcard wins over a named type next to it");
  assert.deepEqual(missedBy([]), [], "a webhook subscribed to nothing hears nothing it could be blamed for");
});

test("an event listed less than 3 minutes ago may still be on its way: it is pending, not missed", () => {
  const input = { now: NOW, listed: [listedAt(MISSED_GRACE_MS - 1, "WH-NEW"), listedAt(MISSED_GRACE_MS, "WH-OLD")], heard: [] as string[] };
  const { missed, pending } = witnessMisses(input);
  assert.deepEqual(missed.map((m) => m.eid), ["WH-OLD"]);
  assert.equal(pending, 1);
});

test("heartbeatOfScan reads the scan and the view it already has: listed + not heard = missed; heard = not; unread list = nothing to compare; no extra reads", async () => {
  const w = gapWorld();
  const sid = await w.session("good");
  const a = await w.order(sid, { book: "paid", eventsListed: true }); // listed, the witness heard it
  await w.order(sid, { book: "paid", eventsListed: true }); // listed, the witness never heard it
  await w.order(sid, { book: "paid", eventsListed: false }); // not listed yet
  await w.heard({ eid: a.paidEid, tid: "tid-a", type: COMPLETED, resourceId: a.captureId, at: w.clock.now + 11_000 });
  w.clock.now += 10 * 60_000; // long after the grace
  const session = (await w.store.getSession(sid))!;

  const scan = await scanSession(w.deps(), sid, session, { listing: true });
  const view = await buildView(w.store, sid, session, w.clock.now);
  const hb = heartbeatOfScan(scan, view);
  assert.equal(hb.state, "missed");
  assert.equal(hb.listedMissedByWitness, 1, "b: listed and never heard (a was heard, c is not listed)");
  assert.equal(hb.lastDeliveryAt, a.at + 11_000);
  assert.equal(scan.listing.asked, true, "the snapshot asks for the list even though every row agrees");
  assert.equal(w.paypal.calls.list, 1);

  // Without the option a healthy session never asks, and then the heartbeat says so instead of claiming 0.
  const quiet = await scanSession(w.deps(), sid, session);
  assert.equal(quiet.listing.asked, false);
  const hb2 = heartbeatOfScan(quiet, view);
  assert.equal(hb2.listedMissedByWitness, null);
  assert.match(hb2.text, /could not be read/);
});
