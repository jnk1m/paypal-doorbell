// A13 item 9 (plan R13): how many Redis commands does a live-lane session cost in 10 minutes? Two things multiply: what one poll sends (counted here with the
// real store, limiter and snapshot code on an in-memory stand-in: lib/run/poll-cost.ts, no database and no network) and how many polls the lane makes (the
// lane's own pollDelayMs, replayed on a timeline of what the session does). Nothing is sent to Redis or PayPal.
//   npx tsx scripts/measure-poll-cadence.ts [--out docs/measurements/s6-a13-redis-2026-10-21.json]
//
// The cadence BEFORE is the lane as it was on main 5f13c23 (S6 changed it): written out below so that the number can be reproduced after the change.
// The timelines are models, not measured sessions: the delays in them are the measured ones (books settle 45 s, PayPal lists an event after 80 to 163 s, a
// resend arrives in about 3 s: CLAUDE.md, docs/measurements/s3-*.json) and the order of a visit is the judge's five steps.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { measurePoll } from "../lib/run/poll-cost.ts";
import { computeDiffs } from "../lib/shop/diffs.ts";
import { pollDelayMs, type Pace } from "../lib/ui/live.ts";

// Not imported from lib/cause/test-helpers.ts: that file is left out of the deployed upload (.vercelignore) and the deploy's type check reads scripts/.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The lane before S6: 3, 6, 12 s while a row moves, 5, 10, 20 s otherwise, for as long as the page is open. Its snapshot key also moved on its own (the heartbeat's
// "12 s ago", a wait's countdown, the server's re-check), which restarted the ladder; that is not modelled, so the "before" numbers are a lower bound.
const delayBefore = (unchanged: number, pace: Pace): number => (pace === "moving" ? 3_000 * 2 ** Math.min(unchanged, 2) : Math.min(20_000, 5_000 * 2 ** Math.min(unchanged, 2)));

interface Version {
  t: number; // seconds: the snapshot is this from then on
  pace: Pace; // what the lane reads from it (paceOf)
  what: string;
}
interface Timeline {
  acts: { t: number; what: string }[]; // a press of a control: one poll at once, and the ladder starts again
  versions: Version[];
}

// The lane's loop (app/_components/live-lane.tsx): a poll at once; each poll sets `unchanged` (0 when the snapshot differs from the last one) and the pace;
// the next poll comes `delay(unchanged, pace)` after the last poll of the loop. An action polls at once with `unchanged` reset, and (after S6 only) starts the
// wait again. `restartOnAct` is that last difference.
function replay(delay: (unchanged: number, pace: Pace) => number, tl: Timeline, untilS: number, restartOnAct: boolean): number[] {
  const times: number[] = [];
  let unchanged = 0;
  let last = -1;
  let pace: Pace = "idle";
  const poll = (t: number): void => {
    times.push(t);
    let v = 0;
    tl.versions.forEach((x, i) => {
      if (x.t <= t) v = i;
    });
    unchanged = v === last ? unchanged + 1 : 0;
    last = v;
    pace = tl.versions[v].pace;
  };
  const acts = tl.acts.map((a) => a.t).sort((a, b) => a - b);
  let next = 0;
  for (;;) {
    const a = acts[0];
    if (a !== undefined && a <= next && a <= untilS) {
      acts.shift();
      unchanged = 0;
      poll(a);
      if (restartOnAct) next = a + delay(unchanged, pace) / 1000;
      continue;
    }
    if (next > untilS) break;
    poll(next);
    next += delay(unchanged, pace) / 1000;
  }
  return times.map((t) => Math.round(t * 10) / 10);
}

const idle: Timeline = { acts: [], versions: [{ t: 0, pace: "idle", what: "a session is open and nothing is done" }] };
const active: Timeline = {
  acts: [
    { t: 17, what: "the judge places an order" },
    { t: 82, what: "turns on a bug" },
    { t: 101, what: "refunds the order" },
    { t: 250, what: "switches to the working handler" },
    { t: 272, what: "presses Ring again" },
  ],
  versions: [
    { t: 0, pace: "idle", what: "the session opens: no orders" },
    { t: 17, pace: "waiting", what: "the order is placed: the books are given time to settle" },
    { t: 29, pace: "waiting", what: "the payment event is heard and the shop booked it" },
    { t: 62, pace: "idle", what: "the row is tied" },
    { t: 82, pace: "idle", what: "the bug is on" },
    { t: 101, pace: "waiting", what: "the refund is asked for: the row is too new to call" },
    { t: 113, pace: "waiting", what: "the refund event is heard; the shop answered 200 and booked nothing" },
    { t: 148, pace: "waiting", what: "the gap is found; PayPal has not listed the refund event yet" },
    { t: 230, pace: "idle", what: "PayPal lists the event: Ring again is on, the judge's turn" },
    { t: 250, pace: "idle", what: "the working handler is on" },
    { t: 272, pace: "moving", what: "Ring again: the resend is on its way" },
    { t: 275, pace: "moving", what: "the resend arrived; the books are checked" },
    { t: 290, pace: "idle", what: "the row is tied" },
  ],
};

async function main(): Promise<void> {
  const cost = await measurePoll(computeDiffs(ROOT), 20);
  const perPoll = cost.commandsPerPoll;
  const summary = (times: number[]) => ({ polls: times.length, commands: times.length * perPoll, at: times });
  const result = {
    at: new Date().toISOString(),
    base: "main 5f13c23 (S6 branch s6-live)",
    method:
      "commands per poll: lib/run/poll-cost.ts, the real RedisShopStore, limiter and snapshot code on an in-memory Redis that counts every command (a call is 1, each pipelined command is 1; an EVAL is 1), 20 polls of a 3-order session. Polls per 10 minutes: the lane's own pollDelayMs replayed on a timeline (a model, not a measured session). Nothing was sent to Redis or PayPal. The server's own count (an EVAL counts the commands inside it) is not re-measured here: docs/measurements/s5-poll-cost.json has 6.35 per poll on the real database (10-19).",
    perPoll: { polls: cost.polls, wrapperCommands: perPoll, wrapperByName: cost.byName, serverCommands: 6.35, serverCommandsNote: "from docs/measurements/s5-poll-cost.json, not re-measured" },
    plan: 60,
    tenMinutes: {
      idle: {
        note: "a session is opened and nothing is done; the tab stays open and visible",
        before: summary(replay(delayBefore, idle, 600, false)),
        after: summary(replay(pollDelayMs, idle, 600, true)),
      },
      active: {
        note: "a visit in the judge's five steps (model timeline below), then quiet until minute 10",
        timeline: { acts: active.acts, snapshots: active.versions },
        before: summary(replay(delayBefore, active, 600, false)),
        after: summary(replay(pollDelayMs, active, 600, true)),
      },
    },
    criterion: {
      problem: "A13 item 9 says 'at most 60 Redis commands per session per 10 minutes'. One poll is 7 commands, so 60 is 8 polls. A lane that is waiting for PayPal (its event list takes 80 to 163 s, its own retries about 163 s) polls every 5 to 20 s, which is 10 to 30 polls in those minutes: 60 cannot hold for a session that does anything, whatever the pace, without the page going stale.",
      kept: "an idle session (open, nothing done) costs at most 60 in 10 minutes: 49 now, 224 before",
      proposal: "Keep 60 for an idle session. For a session that is used, replace it with (a) one poll is at most 7 commands, pinned by lib/run/poll-cost.test.ts, and (b) the hourly caps already in lib/limits.ts: 300 polls per session per hour (2,100 commands) and 600 for all sessions (4,200 commands). The modelled five-step visit costs about 270 commands in its 10 minutes, and a judge's visit is one such session. The owner decides.",
      notDone: "Reading less per poll (a version counter written by every write, read first by the poll) would cut an unchanged poll to 2 or 3 commands, but the waits are on PayPal's clock, which no Redis key shows, so the full scan would still run every 5 to 20 s while a gap waits. It changes the store's layout and is not done here.",
    },
    fitsInPlan: {
      idleBefore: false,
      idleAfter: true,
      activeAfter: false,
      pollsThatFitInSixty: Math.floor(60 / perPoll),
      note: "60 commands is 8 polls. The idle lane makes 7. An active visit needs the lane to poll while PayPal's clock is awaited, which is many more than 8; no pace keeps that inside 60 without making the page unusable (lib/limits.ts says the same). See criterion.",
    },
  };
  result.fitsInPlan.idleBefore = result.tenMinutes.idle.before.commands <= 60;
  result.fitsInPlan.idleAfter = result.tenMinutes.idle.after.commands <= 60;
  result.fitsInPlan.activeAfter = result.tenMinutes.active.after.commands <= 60;
  console.log(JSON.stringify(result, null, 1));
  const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : join(ROOT, "docs/measurements/s6-a13-redis-2026-10-21.json");
  writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  console.log(`wrote ${out}`);
}

await main();
