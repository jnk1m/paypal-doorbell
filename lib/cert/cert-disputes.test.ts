// The certificate with disputes (Track B, variant L): a dispute the books do not show is a gap row and counts as money under dispute; the
// cannot-prove lines say what the scan could not show; nothing PayPal sent as text reaches a sentence; no row, number or word of a scan from
// before disputes existed changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPUTE_CREATED } from "../gaps/disputes.ts";
import { scanSession, type ScanResult } from "../gaps/scan.ts";
import { gapWorld } from "../gaps/test-world.ts";
import { certificateOf } from "./cert.ts";
import * as templates from "./templates.ts";

type World = ReturnType<typeof gapWorld>;
const scan = (w: World, sid: string) => scanSession(w.deps({ disputes: { reads: w.disputeReads } }), sid, { mode: "good", at: 0 });

async function shopWithDispute(w: World, over: Parameters<World["dispute"]>[1] = {}) {
  const sid = await w.session();
  const orders = [];
  for (let i = 0; i < 3; i++) orders.push(await w.order(sid, { book: "paid", eventsListed: true }));
  w.clock.now += 5 * 60_000;
  w.dispute(orders[0].captureId, { ageMs: 4 * 60_000, due: true, status: "WAITING_FOR_SELLER_RESPONSE", pending: true, ...over });
  return { sid, orders };
}

test("one dispute the books do not show: a red stamp with one gap, the header and the owner view name the dispute and its money, and no payment or refund is invented", async () => {
  const w = gapWorld();
  const { sid } = await shopWithDispute(w);
  const cert = certificateOf(await scan(w, sid));
  assert.equal(cert.stamp, "red");
  assert.equal(cert.stampText, "1 gap · Tied on 2/3");
  assert.equal(cert.header, "1 of 3 captures did not match PayPal · 1 open dispute on PayPal that the books do not show ($48.00) · checked 3 of 3 captures.");
  assert.deepEqual([cert.numbers.rows, cert.numbers.tied, cert.numbers.gaps, cert.numbers.unverified, cert.numbers.checked, cert.numbers.coveragePct], [3, 2, 1, 0, 3, 100]);
  assert.deepEqual([cert.numbers.moneyNotInBooks, cert.numbers.refundsNotInBooks, cert.numbers.byClass], ["0.00", 0, {}], "the refund and payment figures are untouched: a dispute is neither");
  assert.deepEqual(cert.numbers.disputes, { open: 1, notInBooks: 1, unverified: 0, unsubscribed: 1, noWebhook: 1, moneyNotInBooks: "48.00", unreadable: 0 });
  assert.deepEqual(cert.ownerView.slice(0, 4), [
    "We checked 3 of your 3 orders against PayPal's own records.",
    "PayPal lists 1 open dispute on your orders that your books do not show. That is $48.00 under dispute.",
    "Your shop's webhook is not set up to hear about disputes, so PayPal would not have told it.",
    "These need your attention: your books and PayPal disagree.",
  ]);
  assert.ok(!cert.ownerView.some((l) => /refund|payment/.test(l)), "no sentence about a refund or a payment that is not there");
});

test("the cannot-prove lines: no webhook means no event could be counted, the due date is the test call's, and both carry their numbers", async () => {
  const w = gapWorld();
  const { sid } = await shopWithDispute(w);
  const cert = certificateOf(await scan(w, sid));
  assert.deepEqual(cert.limits, [
    "1 dispute: no webhook of this app subscribes to dispute events, so whether PayPal would have sent an event cannot be proven from here (in our one test it listed none in 8 minutes).",
    "A Sandbox dispute's response-due date is the one the test call that made it asked for, not a deadline that PayPal's own rules produced.",
  ]);
});

test("another webhook of the app subscribes and the shop's does not: the owner is told the shop was not told; the 'no event' limit is not said (an event was made)", async () => {
  const w = gapWorld();
  const { sid } = await shopWithDispute(w);
  w.paypal.webhooks[1].types.push(DISPUTE_CREATED); // the witness
  const cert = certificateOf(await scan(w, sid));
  assert.deepEqual([cert.numbers.disputes?.unsubscribed, cert.numbers.disputes?.noWebhook], [1, 0]);
  assert.ok(cert.ownerView.includes("Your shop's webhook is not set up to hear about disputes, so PayPal would not have told it."));
  assert.ok(!cert.limits.some((l) => /no webhook of this app/.test(l)));
});

test("money under dispute adds up in cents over several disputes, beside a refund gap", async () => {
  const w = gapWorld();
  const sid = await w.session("ack_then_drop");
  const a = await w.order(sid, { refund: true, book: "paid", eventsListed: true });
  const b = await w.order(sid, { book: "paid", eventsListed: true });
  const c = await w.order(sid, { book: "paid", eventsListed: true });
  w.clock.now += 5 * 60_000;
  await w.deliver({ eid: a.refundEid, tid: "t1", type: "PAYMENT.CAPTURE.REFUNDED", resourceId: a.refundId, status: 200, at: a.refundAt + 5000 });
  w.clock.now += 60_000;
  w.dispute(b.captureId, { amount: "0.10" });
  w.dispute(c.captureId, { amount: "0.20" });
  const cert = certificateOf(await scan(w, sid));
  assert.deepEqual([cert.numbers.gaps, cert.numbers.disputes?.notInBooks, cert.numbers.disputes?.moneyNotInBooks, cert.numbers.moneyNotInBooks, cert.numbers.refundsNotInBooks], [3, 2, "0.30", "48.00", 1]);
  assert.match(cert.header, /3 of 3 captures did not match PayPal \(1 answered OK but the books do not match PayPal\) · 2 open disputes on PayPal that the books do not show \(\$0\.30\) · \$48\.00 across 1 refund not in books/);
  assert.ok(cert.ownerView.includes("PayPal lists 2 open disputes on your orders that your books do not show. That is $0.30 under dispute."));
  assert.ok(cert.ownerView.includes("1 refund that PayPal made is still marked as paid in your books. That is $48.00."));
});

test("a dispute that is not provable yet is an unverified row, counted as too new, not as a gap", async () => {
  const w = gapWorld();
  const { sid } = await shopWithDispute(w, { ageMs: 5 * 60_000, pending: false });
  w.paypal.webhooks[0].types.push(DISPUTE_CREATED);
  w.paypal.disputeEvents.push({ eid: "WH-4NY37331K6294023J-5X2155257W973735X", disputeId: w.paypal.disputes.values().next().value![0].disputeId, createTime: w.clock.now - 60_000 });
  const cert = certificateOf(await scan(w, sid));
  assert.equal(cert.stamp, "amber");
  assert.deepEqual([cert.numbers.gaps, cert.numbers.unverified, cert.numbers.disputes?.open, cert.numbers.disputes?.notInBooks, cert.numbers.disputes?.unverified], [0, 1, 1, 0, 1]);
  assert.match(cert.header, /1 too new to verify/);
  assert.ok(!/open dispute on PayPal that the books/.test(cert.header), "an unproven dispute is not announced as one the books miss");
});

test("a dispute list that could not be read is said, with its number, even when no dispute was found; the stamp does not change", async () => {
  const w = gapWorld();
  const sid = await w.session();
  const o = await w.order(sid, { book: "paid" });
  await w.order(sid, { book: "paid" });
  w.paypal.disputeFailing.add(o.captureId);
  const cert = certificateOf(await scan(w, sid));
  assert.equal(cert.stamp, "green");
  assert.deepEqual(cert.numbers.disputes, { open: 0, notInBooks: 0, unverified: 0, unsubscribed: 0, noWebhook: 0, moneyNotInBooks: "0.00", unreadable: 1 });
  assert.deepEqual(cert.limits, ["PayPal's dispute list could not be read for 1 order, so an open dispute on it is not ruled out."]);
  assert.ok(cert.ownerView.includes("PayPal's dispute list could not be read for 1 order, so an open dispute on it is not ruled out."));
});

test("a scan that did not look for disputes has no dispute numbers and no dispute sentence: the certificate is what it was", async () => {
  const w = gapWorld();
  const { sid } = await shopWithDispute(w);
  const plain: ScanResult = await scanSession(w.deps(), sid, { mode: "good", at: 0 });
  const cert = certificateOf(plain);
  assert.equal("disputes" in cert.numbers, false);
  assert.ok(!/dispute/i.test(JSON.stringify(cert)));
});

test("a scan that looked and found nothing carries zeros, and a green stamp still says only 'of what we can see'", async () => {
  const w = gapWorld();
  const sid = await w.session();
  await w.order(sid, { book: "paid" });
  const cert = certificateOf(await scan(w, sid));
  assert.equal(cert.stamp, "green");
  assert.equal(cert.stampText, "Tied on 1/1 of what we can see");
  assert.deepEqual(cert.numbers.disputes, { open: 0, notInBooks: 0, unverified: 0, unsubscribed: 0, noWebhook: 0, moneyNotInBooks: "0.00", unreadable: 0 });
  assert.deepEqual(cert.limits, []);
});

const MARKER = "MARKER-zq7x-INJECTED";
function stringPaths(value: unknown, path: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] {
  if (typeof value === "string") out.push(path);
  else if (Array.isArray(value)) value.forEach((v, i) => stringPaths(v, [...path, i], out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) stringPaths(v, [...path, k], out);
  return out;
}
function withLeaf<T>(value: T, path: (string | number)[], leaf: string): T {
  const copy = structuredClone(value) as Record<string | number, unknown>;
  let at: Record<string | number, unknown> = copy;
  for (const p of path.slice(0, -1)) at = at[p] as Record<string | number, unknown>;
  at[path[path.length - 1]] = leaf;
  return copy as T;
}

test("a marker string injected into any string of a scan with a dispute (ids, status, the finding, the ring, the webhooks) never reaches the certificate", async () => {
  const w = gapWorld();
  const { sid } = await shopWithDispute(w);
  const s = await scan(w, sid);
  const paths = stringPaths(s.rows.map((r) => r.disputes));
  assert.ok(paths.length >= 8, `${paths.length} string places in the disputes`);
  let reached = 0;
  for (const p of stringPaths(s)) {
    if (JSON.stringify(certificateOf(withLeaf(s, p, MARKER))).includes(MARKER)) reached++;
  }
  assert.equal(reached, 0);
  // an amount that is not money is left out of the sum and said so; a status nobody knows is not a verdict
  const odd = structuredClone(s);
  odd.rows[0].disputes![0].amount = MARKER;
  const c = certificateOf(odd);
  assert.equal(c.numbers.disputes?.moneyNotInBooks, "0.00");
  assert.ok(c.limits.some((l) => l.startsWith("1 amount could not be read")));
  assert.ok(!JSON.stringify(c).includes(MARKER));
});

test("the dispute sentences are in no way forbidden: the plan's words are in none of the new templates, called over a range of numbers", () => {
  const FORBIDDEN = ["complete", "nothing missing", "all tied", "every", "no gaps", "all clear", "fully"];
  const hits = (text: string) => FORBIDDEN.filter((word) => new RegExp(`\\b${word.replace(/ /g, "\\s+")}\\b`, "i").test(text));
  const out: string[] = [];
  for (const n of [0, 1, 2, 41]) {
    out.push(templates.header.disputes(n, "48.00"), templates.owner.disputes(n, "48.00"), templates.owner.disputesUnreadable(n), templates.limits.disputeNoWebhook(n), templates.limits.disputesUnreadable(n));
  }
  out.push(templates.owner.disputesNotTold(), templates.limits.disputeDueDate());
  assert.deepEqual(out.flatMap(hits), []);
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "templates.ts"), "utf8");
  assert.deepEqual(hits(source), [], "and the template file, comments included");
});
