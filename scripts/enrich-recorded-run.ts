// Adds two timeline fields to the stored recorded run without recording again (they were not in the scan when the run was captured):
//   ScanEvent.listedAt     PayPal's own create_time of the event, from PayPal's event list (PayPal's event time, not a send or a delivery time)
//   ScanEvent.heal.sentAt / .arrivedAt   when each resend was accepted (HTTP 202) and when the first resent delivery reached the shop
// The data is the run's own and is still stored: the heal records live in Redis for 24 hours after the run (found through the capture id, which
// is a PayPal id and is in the fixture), and PayPal's event list is read (GET only, no resend, no order, no webhook is touched). Each step gets
// what was true at ITS time: the resends accepted by then, the arrival only if it had happened. Nothing is written for a field that is not known.
//   npx tsx scripts/enrich-recorded-run.ts      (then: npx tsx scripts/record-run.ts --rebuild)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PaypalClientReads } from "../lib/gaps/reads.ts";
import { redisFromEnv } from "../lib/redis.ts";
import type { RecordedScenario } from "../lib/run/snapshot.ts";
import { RedisShopStore } from "../lib/shop/store.ts";
import { appClient, loadEnv, loadRedisEnv } from "./env.ts";

loadEnv();
loadRedisEnv();
const redis = redisFromEnv();
if (!redis) throw new Error("no Upstash settings (.env.vercel)");
const store = new RedisShopStore(redis, "db:");
const reads = new PaypalClientReads(appClient("demo"));
const DIR = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/recorded-run");

for (const id of ["refund_never_booked", "late_payment_overwrites", "signature_rejected"] as const) {
  const file = join(DIR, `${id}.json`);
  const s = JSON.parse(readFileSync(file, "utf8")) as RecordedScenario;
  const captures = s.steps[0].session.orders.map((o) => o.captureId);
  const sid = await store.sessionOfCapture(captures[0]);
  if (!sid) throw new Error(`${id}: the capture ${captures[0]} no longer maps to a session (they expire 24 hours after the run); the heal times cannot be recovered without a new run`);
  const { records } = await store.heals(sid);
  const since = Math.min(...s.steps[0].session.orders.map((o) => o.at)) - 120_000;
  const listed = new Map((await reads.listedEvents(since, 30_000)).map((e) => [e.eid, e.createTime]));

  let listedAt = 0;
  let healTimes = 0;
  const problems: string[] = [];
  for (const step of s.steps) {
    const scanEnd = step.scan!.at + step.scan!.durationMs;
    for (const row of step.scan!.rows) {
      for (const e of row.events) {
        if (e.listed && e.eid) {
          const t = listed.get(e.eid);
          if (t === undefined) problems.push(`step ${step.step!.index}: ${e.eid} was listed then and is not in PayPal's list now`);
          else {
            e.listedAt = t;
            listedAt++;
          }
        }
        const rec = e.eid ? records[e.eid] : undefined;
        if (e.heal && rec) {
          const sentAt = rec.sends.filter((t) => t <= scanEnd);
          if (sentAt.length !== e.heal.sends) problems.push(`step ${step.step!.index}: ${e.eid} has ${e.heal.sends} resends in the scan and ${sentAt.length} in the record at that time`);
          e.heal.sentAt = sentAt;
          if (rec.arrivedAt !== undefined && rec.arrivedAt <= scanEnd) e.heal.arrivedAt = rec.arrivedAt;
          else delete e.heal.arrivedAt;
          healTimes++;
        } else if (e.heal) {
          problems.push(`step ${step.step!.index}: ${e.eid ?? "?"} has a heal in the scan and no heal record any more`);
        }
      }
    }
  }
  writeFileSync(file, `${JSON.stringify(s, null, 1)}\n`);
  console.log(`${id}: listedAt on ${listedAt} events, resend times on ${healTimes} heals${problems.length ? `; PROBLEMS: ${problems.join(" | ")}` : ""}`);
}
