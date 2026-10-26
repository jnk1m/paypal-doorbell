// DO NOT CHANGE 3 / R9: nothing the hosted default shows may claim more than it proved. The words the plan forbids (complete, nothing missing,
// all tied, every, no gaps, all clear, fully) are searched, case-insensitive and as whole words, in EVERY string of the recorded-run
// fixtures (keys and values), in the step titles, in everything the certificate and the heartbeat say for those steps, and in the cause and replay
// sentences the screen builds from them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CAUSE_TEMPLATE, NOT_DIAGNOSED_TEXT, NOT_PROVEN_TEXT } from "../cause/categories.ts";
import { replaySentence } from "../cause/replay.ts";
import { ROOT } from "../cause/test-helpers.ts";
import { certificateOf, rowsInsideListLag } from "../cert/cert.ts";
import * as templates from "../cert/templates.ts";
import { heartbeatOfScan } from "../witness/heartbeat.ts";
import { RECORDED_SCENARIOS } from "./recorded.ts";
import { finalTitle, FIRST_TITLES, FIX_TITLES, ringTitle } from "./titles.ts";

const FORBIDDEN = ["complete", "nothing missing", "all tied", "every", "no gaps", "all clear", "fully"];
const PATTERNS = FORBIDDEN.map((w) => ({ w, re: new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`, "i") }));
const hits = (text: string): string[] => PATTERNS.filter((p) => p.re.test(text)).map((p) => p.w);

// Every string in a JSON value, keys included, with where it was found.
function strings(value: unknown, path = "$", out: { path: string; text: string }[] = []): { path: string; text: string }[] {
  if (typeof value === "string") out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push({ path: `${path}.${k} (key)`, text: k });
      strings(v, `${path}.${k}`, out);
    }
  }
  return out;
}

test("the matcher works: whole words, any case, and not inside longer words (a status of COMPLETED is not the word 'complete')", () => {
  assert.deepEqual(hits("answered 401 every time"), ["every"]);
  assert.deepEqual(hits("Nothing  Missing here"), ["nothing missing"]);
  assert.deepEqual(hits("ALL CLEAR. Fully done. No gaps. All tied. Complete."), ["complete", "all tied", "no gaps", "all clear", "fully"]);
  assert.deepEqual(hits("PAYMENT.CAPTURE.COMPLETED, everyone, incomplete, overfully, 1 gap"), []);
});

test("every string in fixtures/recorded-run/*.json is free of the forbidden words", () => {
  const dir = join(ROOT, "fixtures/recorded-run");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  // The five planted-bug runs (the 401 bug has two recordings), and the dispute run (dispute_never_heard.json); nothing else is in the folder.
  const FIVE = ["cause_not_in_code.json", "late_payment_overwrites.json", "refund_never_booked.json", "resend_not_delivered.json", "signature_rejected.json"];
  assert.deepEqual(files.filter((f) => f !== "dispute_never_heard.json").sort(), FIVE);
  let scanned = 0;
  const found: string[] = [];
  for (const f of files) {
    for (const s of strings(JSON.parse(readFileSync(join(dir, f), "utf8")))) {
      scanned++;
      for (const w of hits(s.text)) found.push(`${f} ${s.path}: "${w}" in "${s.text.slice(0, 100)}"`);
    }
  }
  assert.ok(scanned > 5000, `${scanned} strings scanned`);
  assert.deepEqual(found, []);
});

test("every step title, and every title the code can write, is free of the forbidden words", () => {
  const titles: string[] = [...Object.values(FIRST_TITLES), ...Object.values(FIX_TITLES)];
  for (const s of RECORDED_SCENARIOS) {
    const caps = s.steps[0].scan!.rows.filter((r) => r.status === "GAP").map((r) => r.captureId);
    for (const step of s.steps) {
      titles.push(step.step!.title);
      titles.push(ringTitle(step, caps), finalTitle(step, caps)); // what the functions say for every step's rows, not only the two steps they are meant for
    }
  }
  assert.ok(titles.length >= 5 + 5 + 24);
  assert.deepEqual(titles.flatMap(hits), []);
  assert.deepEqual(RECORDED_SCENARIOS.flatMap((s) => s.steps.map((x) => x.step!.title)).flatMap(hits), []);
});

test("everything the certificate and the heartbeat say in the recorded steps, and the sentences the screen builds from the causes and replays, are free of the forbidden words", () => {
  const texts: string[] = [templates.FOOTNOTE, NOT_PROVEN_TEXT, NOT_DIAGNOSED_TEXT, ...Object.values(CAUSE_TEMPLATE)];
  for (const s of RECORDED_SCENARIOS) {
    for (const step of s.steps) {
      const cert = certificateOf(step.scan!, { rowsInsideListLag: rowsInsideListLag(step.session.orders, step.scan!.at) });
      texts.push(cert.stampText, cert.header, cert.footnote, ...cert.limits, ...cert.ownerView, heartbeatOfScan(step.scan!, step.session).text, step.certificate!.stampText, step.certificate!.header, ...step.certificate!.limits, ...step.certificate!.ownerView, step.heartbeat!.text);
      for (const c of step.causes) {
        if (c.replay) texts.push(replaySentence(c.replay), c.replay.expectation);
        if (c.confirmation) texts.push(c.confirmation.chip, c.confirmation.note ?? "");
        if (c.cause.status === "proposed") texts.push(c.cause.explanation);
      }
    }
  }
  assert.ok(texts.length > 100);
  assert.deepEqual(texts.flatMap(hits), []);
});
