// R12 / A12 (the loader part): the recorded run is data. It loads and plays with no environment variable, with fetch failing and with Upstash
// unreachable; its first step already shows 2 gaps; every step is the product's own output (the certificate and the heartbeat are what the
// product code computes from the stored scan), so a recording cannot show what the live product would not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { symptomClassOf } from "../cause/categories.ts";
import { replaySentence } from "../cause/replay.ts";
import { ROOT } from "../cause/test-helpers.ts";
import { certificateOf, rowsInsideListLag } from "../cert/cert.ts";
import { heartbeatOfScan } from "../witness/heartbeat.ts";
import { RECORDED_SCENARIOS, recordedScenario, recordedStep } from "./recorded.ts";
import { finalTitle, FIRST_TITLES, FIX_TITLES, ringTitle } from "./titles.ts";
import type { RecordedScenario, RunSnapshot } from "./snapshot.ts";

const MODE_OF: Record<RecordedScenario["id"], RecordedScenario["plantedMode"]> = { refund_never_booked: "ack_then_drop", late_payment_overwrites: "last_write_wins", signature_rejected: "bad_body", resend_not_delivered: "bad_body", cause_not_in_code: "wrong_webhook_id_setting" };

test("A12: with every environment variable removed and every fetch failing, the five scenarios load and every step can be read (Upstash, PayPal and the model are not reached)", async () => {
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;
  let fetches = 0;
  for (const k of Object.keys(process.env)) delete process.env[k];
  globalThis.fetch = (() => {
    fetches++;
    throw new Error("the recorded run must not touch the network");
  }) as typeof fetch;
  try {
    // A fresh evaluation of the module under that environment: nothing it needs may come from somewhere but its own files.
    const fresh = (await import(`./recorded.ts?no-env=${Date.now()}`)) as typeof import("./recorded.ts");
    assert.equal(fresh.RECORDED_SCENARIOS.length, 5);
    let steps = 0;
    for (const s of fresh.RECORDED_SCENARIOS) for (let i = 0; i < s.steps.length; i++) assert.equal(fresh.recordedStep(s, i).mode, "RECORDED RUN"), steps++;
    assert.ok(steps >= 9);
    // Upstash configured and failing (the quota is spent): the variables are there and every call errors. Still nothing is asked.
    process.env.KV_REST_API_URL = "https://upstash.invalid";
    process.env.KV_REST_API_TOKEN = "spent";
    assert.equal(fresh.recordedScenario("refund_never_booked").steps[0].mode, "RECORDED RUN");
    assert.equal(fetches, 0, "0 external requests");
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    globalThis.fetch = savedFetch;
  }
});

test("A12: the loader has no way to reach anything: its source reads no environment, imports only JSON and types, and names no client", () => {
  const src = readFileSync(join(ROOT, "lib/run/recorded.ts"), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/process\.env|fetch\(|redis|upstash|paypal\.ts|anthropic|XMLHttpRequest|node:net|node:http/i.test(src));
  const imports = [...src.matchAll(/^import\s.*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
  assert.ok(imports.length >= 4);
  for (const i of imports) assert.ok(i.endsWith(".json") || i === "./snapshot.ts", `import ${i}`);
  assert.ok(src.split("\n").filter((l) => l.startsWith("import ") && l.includes("./snapshot.ts")).every((l) => l.startsWith("import type")));
});

test("A12: the first step of every scenario already shows 2 gaps, and the band says RECORDED RUN with the date of the real run", () => {
  for (const s of RECORDED_SCENARIOS) {
    const first = recordedStep(s, 0);
    assert.equal(first.scan!.summary.gaps, 2, `${s.id}: 2 gaps on the first screen`);
    assert.equal(first.certificate!.numbers.gaps, 2);
    assert.equal(first.certificate!.stamp, "red");
    assert.equal(first.certificate!.numbers.moneyNotInBooks, "96.00");
    assert.ok(first.causes.length >= 2, `${s.id}: the cause is there from the start`);
    for (const step of s.steps) {
      assert.equal(step.mode, "RECORDED RUN");
      assert.ok(typeof step.recordedAt === "number" && step.recordedAt > Date.parse("2026-10-19T00:00:00Z") && step.recordedAt < Date.now() + 1000, "a real date");
    }
    assert.equal(s.capturedAt, first.recordedAt);
  }
});

test("each scenario is 3 to 5 steps, numbered 1..n of n, with a title, in time order, and planted by the mode the scenario names", () => {
  assert.deepEqual(RECORDED_SCENARIOS.map((s) => s.id), ["refund_never_booked", "late_payment_overwrites", "signature_rejected", "resend_not_delivered", "cause_not_in_code"]);
  for (const s of RECORDED_SCENARIOS) {
    assert.equal(s.plantedMode, MODE_OF[s.id], s.id);
    assert.ok(s.steps.length >= 3 && s.steps.length <= 5, `${s.id}: ${s.steps.length} steps`);
    s.steps.forEach((step, i) => {
      assert.deepEqual([step.step?.index, step.step?.of], [i + 1, s.steps.length]);
      assert.ok(step.step!.title.length > 10);
      if (i > 0) assert.ok(step.recordedAt! >= s.steps[i - 1].recordedAt!, "time order");
    });
    assert.equal(recordedScenario(s.id), s);
    assert.equal(recordedStep(s, -5), s.steps[0]);
    assert.equal(recordedStep(s, 99), s.steps.at(-1));
  }
  assert.throws(() => recordedScenario("nope" as never), /no recorded scenario/);
});

test("every step is the product's own output: the certificate and the heartbeat are what the code computes from the stored scan, and the stamp follows the rule", () => {
  for (const s of RECORDED_SCENARIOS) {
    for (const step of s.steps) {
      const where = `${s.id} step ${step.step!.index}`;
      assert.ok(step.scan, where);
      assert.deepEqual(step.certificate, certificateOf(step.scan!, { rowsInsideListLag: rowsInsideListLag(step.session.orders, step.scan!.at) }), `${where}: the certificate is certificateOf(scan) (npx tsx scripts/record-run.ts --rebuild recomputes it)`);
      assert.deepEqual(step.heartbeat, heartbeatOfScan(step.scan!, step.session), `${where}: the heartbeat`);
      const n = step.certificate!.numbers;
      assert.equal(step.certificate!.stamp, n.gaps > 0 ? "red" : n.unverified === 0 && n.rows > 0 ? "green" : "amber", where);
      assert.equal(step.certificate!.signed, false);
      assert.equal(step.session.session.planted, step.session.session.mode !== "good");
    }
  }
});

test("a cause is never paired with another mode's replay, and the planted label is on every planted step (DO NOT CHANGE 8)", () => {
  for (const s of RECORDED_SCENARIOS) {
    for (const step of s.steps) {
      for (const c of step.causes) {
        assert.equal(c.mode, s.plantedMode);
        assert.equal(c.mode, step.session.session.mode, "the cause is for the mode the session is in");
        if (c.replay) assert.equal(c.replay.mode, c.mode);
        if (c.cause.status === "proposed") assert.equal(c.confirmation?.confirmed, c.replay?.verdict === "CONFIRMED BY REPLAY");
      }
      if (step.session.session.planted) assert.equal(step.session.session.plantedLabel, "planted by us");
    }
    const first = s.steps[0];
    // the setting bug's deploy changed only a comment: its cause is not proven, and a cause that is not proposed has no replay at all
    if (s.plantedMode === "wrong_webhook_id_setting") {
      assert.ok(first.causes.length > 0 && first.causes.every((c) => c.cause.status === "not_proven" && c.replay === null && c.confirmation === null), s.id);
      continue;
    }
    const replay = first.causes[0].replay!;
    assert.equal(replay.basis, "replayed", `${s.id}: the replay in the first step was a real one`);
    assert.equal(first.causes[0].confirmation?.chip, "CONFIRMED BY REPLAY");
    // It ran during the recording, so a visitor days later must not read "replayed just now" next to the RECORDED RUN band: the sentence
    // shows the age (from ranAt) as the page renders it.
    assert.ok(replay.ranAt <= first.recordedAt! && first.recordedAt! - replay.ranAt < 60_000, "the replay ran just before the step was captured");
    assert.match(replaySentence(replay, replay.ranAt + 3 * 60_000), /\(replayed 3 min ago\)$/);
    // the day and minute each recorded replay ran (UTC); resend_not_delivered is the 10-19 recording of the same planted bug as signature_rejected
    const RAN: Record<string, string> = { refund_never_booked: "Oct 20, 10:43", late_payment_overwrites: "Oct 20, 10:45", signature_rejected: "Oct 20, 11:57", resend_not_delivered: "Oct 19, 12:29" };
    assert.equal(replaySentence(replay, replay.ranAt + 3 * 24 * 3600_000).match(/\(replayed on (.*) UTC\)$/)?.[1], RAN[s.id], s.id);
    assert.doesNotMatch(replaySentence(replay, Date.now()), /just now/, `${s.id}: rendered now, the recording is not 'just now'`);
    for (const step of s.steps) for (const c of step.causes) if (c.replay) assert.doesNotMatch(replaySentence(c.replay, step.recordedAt! + 120_000), /just now/);
    const attempts = first.scan!.rows.flatMap((r) => r.events.filter((e) => e.finding)).map((e) => symptomClassOf(e.s));
    assert.ok(attempts.length >= 2);
  }
});

test("honest labels: a row is TIED only when the books changed to what PayPal says, 'healed' only for a TIED row, and each title is what titles.ts says about its step", () => {
  for (const s of RECORDED_SCENARIOS) {
    const caps = s.steps[0].scan!.rows.filter((r) => r.status === "GAP").map((r) => r.captureId);
    assert.equal(caps.length, 2);
    for (const step of s.steps) {
      const where = `${s.id} step ${step.step!.index}`;
      for (const row of step.scan!.rows) {
        if (row.status === "TIED") assert.equal(row.book?.state, row.truth === "refunded" ? "refunded" : "paid", `${where}: a tied row's books agree with PayPal's own answer`);
        for (const e of row.events) if (e.heal?.state === "healed") assert.equal(row.status, "TIED", `${where}: healed means tied`);
      }
    }
    const [first, fix, ring] = s.steps;
    const last = s.steps.at(-1)!;
    assert.equal(first.step!.title, FIRST_TITLES[s.id]);
    assert.equal(fix.step!.title, FIX_TITLES[s.id]);
    assert.equal(fix.session.session.mode, "good", "the fix step is after the switch to the good handler");
    assert.equal(ring.step!.title, ringTitle(ring, caps));
    assert.equal(last.step!.title, finalTitle(last, caps));
    assert.equal(first.session.session.mode, s.plantedMode);
    const rows = caps.map((c) => last.scan!.rows.find((r) => r.captureId === c)!);
    const tied = rows.filter((r) => r.status === "TIED").length;
    if (tied === rows.length) assert.match(last.step!.title, /^All 2 rows are tied again/);
    else assert.match(last.step!.title, /resend accepted, not delivered/, "a gap that stayed open is said to be exactly that");
    for (const r of rows.filter((x) => x.status !== "TIED")) assert.notEqual(r.events.find((e) => e.heal)?.heal?.state, "healed");
  }
  // resend_not_delivered is the one where a resend of an event that was rejected 3 times is accepted and often not delivered (S3: 4 of 37). It is the
  // 10-19 recording of the bad_body bug; signature_rejected (10-20) is the recording of the same bug whose resends all arrived.
  const c = recordedScenario("resend_not_delivered");
  assert.match(c.steps.at(-1)!.step!.title, /resend accepted, not delivered/);
  assert.match(recordedScenario("signature_rejected").steps.at(-1)!.step!.title, /^All 2 rows are tied again.*\(2 needed more than one resend\)\.$/);
});

test("PayPal ids a judge can look up: each scenario lists order, capture, refund and event ids, all of which appear in its steps", () => {
  for (const s of RECORDED_SCENARIOS) {
    assert.ok(s.paypalIds.length >= 12, `${s.id}: ${s.paypalIds.length} ids`);
    assert.ok(s.paypalIds.every((id) => /^[A-Za-z0-9_-]{10,}$/.test(id)));
    const text = JSON.stringify(s.steps);
    for (const id of s.paypalIds) assert.ok(text.includes(id), id);
    const captures = s.steps[0].session.orders.map((o) => o.captureId);
    for (const c of captures) assert.ok(s.paypalIds.includes(c), "capture ids are in the list");
    assert.ok(s.paypalIds.some((id) => id.startsWith("WH-")), "event ids too");
  }
});

test("nothing that was a credential survives: the session id is a stand-in, no token or key appears in the recordings", () => {
  const SECRET_LOOKING = /(sk-ant-|Bearer |client_secret|DOORBELL_LIVE|KV_REST|x-live-token|BEGIN [A-Z ]*PRIVATE)/i;
  // an environment variable's name is upper case; matched without /i so that a data id like the fix's "paypal_books" control is not a hit
  const ENV_NAME = /\b(PAYPAL|ANTHROPIC|KV|UPSTASH|DOORBELL)_[A-Z]/;
  for (const s of RECORDED_SCENARIOS) {
    const text = readFileSync(join(ROOT, "fixtures/recorded-run", `${s.id}.json`), "utf8");
    assert.ok(!SECRET_LOOKING.test(text), s.id);
    assert.ok(!ENV_NAME.test(text), `${s.id}: ${text.match(ENV_NAME)?.[0]}`);
    for (const step of s.steps) assert.match(step.session.session.id, /^[0-9a-f]{32}$/);
    assert.equal(new Set(s.steps.map((x: RunSnapshot) => x.session.session.id)).size, 1, "one session throughout");
  }
});

test("the timeline fields are filled from the run's own data: listedAt (PayPal's event time) on every listed event, resend times and the arrival on every heal, each step with what was true at its time", () => {
  let listedEvents = 0;
  let heals = 0;
  for (const s of RECORDED_SCENARIOS) {
    for (const step of s.steps) {
      const where = `${s.id} step ${step.step!.index}`;
      const scanEnd = step.scan!.at + step.scan!.durationMs;
      for (const row of step.scan!.rows) {
        const order = step.session.orders.find((o) => o.captureId === row.captureId)!;
        for (const e of row.events) {
          if (e.listed) {
            listedEvents++;
            assert.equal(typeof e.listedAt, "number", `${where}: a listed event has PayPal's create_time`);
            const action = e.kind === "completed" ? order.at : order.refundAt!;
            assert.ok(Math.abs(e.listedAt! - action) < 3 * 60_000, `${where}: PayPal created the event close to the action (${Math.round((e.listedAt! - action) / 1000)} s)`);
            assert.ok(e.listedAt! < scanEnd);
          } else assert.equal(e.listedAt, undefined, `${where}: an event that is not listed has no listedAt`);
          if (e.heal) {
            heals++;
            assert.equal(e.heal.sentAt?.length, e.heal.sends, `${where}: one time for each resend`);
            assert.deepEqual([...e.heal.sentAt!].sort((a, b) => a - b), e.heal.sentAt, "in order");
            assert.ok(e.heal.sentAt!.every((t) => t <= scanEnd), "no resend from the future of this step");
            if (e.heal.arrivedAt !== undefined) {
              assert.ok(e.heal.arrivedAt > e.heal.sentAt![0] && e.heal.arrivedAt <= scanEnd, `${where}: it arrived after the first 202 and before this step was taken`);
              const sentBefore = [...e.heal.sentAt!].reverse().find((t) => t <= e.heal!.arrivedAt!)!;
              assert.equal(e.heal.arrivalSeconds, Math.round((e.heal.arrivedAt - sentBefore) / 100) / 10, `${where}: arrivalSeconds is the arrival minus the resend before it`);
            } else assert.equal(e.heal.arrivalSeconds, undefined);
          }
        }
      }
    }
  }
  assert.ok(listedEvents > 50 && heals >= 12, `${listedEvents} listed events and ${heals} heals carry the times`);
  // the case the UI draws: a row that needed 3 resends has 3 times, and the arrival belongs to the third
  const needed3 = recordedScenario("refund_never_booked").steps.at(-1)!.scan!.rows.flatMap((r) => r.events).find((e) => e.heal?.sends === 3)!.heal!;
  assert.equal(needed3.sentAt!.length, 3);
  assert.ok(needed3.arrivedAt! > needed3.sentAt![2]);
});
