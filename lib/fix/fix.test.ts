// The fix step offline: edits, code checks, allowlist, the baseline and the referee, on the three planted deploys as the product reads them and on
// a mixed deploy, with the shop tests' stand-in for PayPal's verify endpoint (the real endpoint is used by scripts/record-fix.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAllowlist } from "./allowlist.ts";
import { deleteVerify } from "./baselines.ts";
import { checkFix } from "./check.ts";
import { applyEdits, keptUncited, type Edit } from "./edits.ts";
import { CachedVerifier, Referee, tamper } from "./referee.ts";
import { carefulFix, E, GOOD, FILE_OF, idOf, plantedTarget, targetOf, text, world } from "./test-helpers.ts";
import { completedEvent } from "../shop/test-helpers.ts";
import type { PlantedMode } from "../shop/types.ts";

const MODES = Object.keys(FILE_OF) as PlantedMode[];

async function referee() {
  const w = world();
  const r = new Referee(w.scenarios, GOOD, new CachedVerifier(w.paypal.verify));
  await r.prepare();
  return r;
}

test("edit ids: a removed line sits where it was removed, an added line has its line number in the bad file", () => {
  const t = plantedTarget("ack_then_drop");
  assert.equal(t.index.get(idOf(t, "del", "import { bookingOf, rank }"))!.no, 1); // the import went after line 1 (the header comment)
  assert.equal(t.index.get(idOf(t, "del", "ctx.books.set"))!.no, 9); // the booking went after the verify line
  assert.equal(t.index.get(idOf(t, "add", "queue.push(event)"))!.kind, "add");
});

for (const mode of MODES) {
  test(`planted ${mode}: careful edits pass every code check and the referee on signed deliveries`, async () => {
    const t = plantedTarget(mode);
    const fix = carefulFix(mode, t);
    const checked = checkFix(t, new Set(fix.cited), fix.edits);
    assert.ok(checked.ok, JSON.stringify(checked));
    assert.deepEqual(checked.rows.map((r) => r.id), ["edits_valid", "parses", "allowlist", "uncited_kept", "inside_hunks"]);
    assert.ok(checked.rows.every((r) => r.ok));
    const r = await (await referee()).judge(checked.patched!);
    assert.ok(r.pass, JSON.stringify(r.controls));
    assert.match(r.claim, /behaves like the good build and PayPal's answer on these 12 inputs/);
  });
}

test("the bad builds themselves fail the referee (the bug is real on these events)", async () => {
  const ref = await referee();
  for (const mode of MODES) {
    const r = await ref.judge(text(FILE_OF[mode]));
    assert.equal(r.pass, false, mode);
    assert.equal(r.controls.tampered, true, `${mode} still rejects tampered bodies`);
  }
  // last_write_wins only shows when the refund comes first
  const lww = await ref.judge(text(FILE_OF.last_write_wins));
  assert.deepEqual([lww.controls.real, lww.controls.reversed], [true, false]);
});

test("delete the signature check: passes the replay of real events, fails the tampered control", async () => {
  const ref = await referee();
  const lazy = deleteVerify(text(FILE_OF.bad_body));
  assert.doesNotMatch(lazy, /ctx\.verify/);
  const r = await ref.judge(lazy);
  assert.deepEqual(r.controls, { real: true, reversed: true, tampered: false, paypal: true });
  assert.equal(r.pass, false);
  const booked = r.runs.filter((v) => v.name === "tampered").every((v) => v.got.statuses.join() === "200,200" && Object.keys(v.got.books).length === 1);
  assert.ok(booked, "the tampered copies were accepted and booked");
});

test("the same lazy fix written another way is seen through as well", async () => {
  const ref = await referee();
  const sneaky = GOOD.replace('if ((await ctx.verify(event)) !== "SUCCESS") return { status: 401 };', "await ctx.verify(event);");
  const r = await ref.judge(sneaky);
  assert.equal(r.controls.tampered, false);
});

test("the baseline of every proven patch: the patch with its signature check removed passes the replay of real events and fails only the tampered control", async () => {
  const ref = await referee();
  for (const mode of MODES) {
    const t = plantedTarget(mode);
    const fix = carefulFix(mode, t);
    const patched = checkFix(t, new Set(fix.cited), fix.edits).patched!;
    const lazy = await ref.judge(deleteVerify(patched));
    assert.deepEqual(lazy.controls, { real: true, reversed: true, tampered: false, paypal: true }, mode);
  }
});

// A mixed deploy: the same bug as ack_then_drop-like (an un-awaited write) plus a harmless log line right next to it.
const MIXED_BAD = GOOD.replace("  await ctx.books.set(", "  void ctx.books.set(").replace("  return { status: 200 };\n};", '  console.log("booked", booking.captureId);\n  return { status: 200 };\n};');
const AWAITED = "  await ctx.books.set(booking.captureId, { state: booking.state, amount: booking.amount, eid: event.id, at: ctx.now() });";

test("mixed deploy: the edit that restores the await keeps the log line; the other edits that would touch the log line are refused", async () => {
  const ref = await referee();
  const t = targetOf(GOOD, MIXED_BAD, "handlers/webhook.ts");
  assert.equal(new Set([...t.index.values()].map((l) => l.hunk)).size, 1, "bug and feature are in one hunk");
  const bug = idOf(t, "add", "void ctx.books.set");
  const fixed = checkFix(t, new Set([bug]), [E("replace", bug, AWAITED)]);
  assert.ok(fixed.ok, JSON.stringify(fixed));
  assert.match(fixed.patched!, /console\.log\("booked"/);
  assert.ok((await ref.judge(fixed.patched!)).pass);

  // Deleting the log line is not allowed for an edit: it is an added line the cause did not cite.
  const feature = idOf(t, "add", "console.log");
  const greedy = checkFix(t, new Set([bug]), [E("replace", bug, AWAITED), E("delete", feature)]);
  assert.equal(greedy.ok, false);
  assert.equal(greedy.edits[0].code, "target_not_allowed");
  assert.deepEqual(greedy.rows.map((r) => r.ok), [false, false, false, false, false]);
});

test("edit validation: unknown ids, targets that may not be changed, duplicate and malformed edits", () => {
  const t = plantedTarget("ack_then_drop");
  const push = idOf(t, "add", "queue.push(event)");
  const comment = idOf(t, "add", "Acknowledge first");
  const removed = idOf(t, "del", "ctx.books.set");
  const cited = new Set([push]);
  const code = (edits: Edit[]) => checkFix(t, cited, edits).edits.map((e) => e.code);
  assert.deepEqual(code([]), ["no_edits"]);
  assert.deepEqual(code([E("restore", "L99")]), ["unknown_id"]);
  assert.deepEqual(code([E("delete", comment)]), ["target_not_allowed"]); // an added line the cause did not cite
  assert.deepEqual(code([E("replace", removed, "x")]), ["target_not_allowed"]); // a removed line cannot be replaced
  assert.deepEqual(code([E("restore", push)]), ["restore_not_removed"]);
  assert.deepEqual(code([E("replace", push)]), ["replace_without_text"]);
  assert.deepEqual(code([E("insert_after", push)]), ["insert_without_text"]);
  assert.deepEqual(code([E("restore", removed), E("restore", removed)]), ["duplicate_target"]);
  assert.deepEqual(code([E("insert_after", push, "café")]), ["bad_line_text"]);
  assert.deepEqual(code([E("insert_after", push, "a\nb")]), ["bad_line_text"]);
});

test("allowlist: nothing outside ctx, no dynamic import, no new imports, no denied names, no duplicate bindings", () => {
  const withBody = (body: string) => GOOD.replace("  const booking = bookingOf(event);", `  ${body}\n  const booking = bookingOf(event);`);
  const known = new Set<string>();
  const codes = (src: string) => checkAllowlist(src, known).map((p) => `${p.code}:${p.detail}`);
  assert.deepEqual(codes(GOOD), []);
  assert.deepEqual(codes(withBody("const k = process.env.SECRET_KEY;")), ["denied_name:process"]);
  assert.deepEqual(codes(withBody('await fetch("https://example.com");')), ["denied_name:fetch"]);
  assert.deepEqual(codes(withBody("const f = eval;")), ["denied_name:eval"]);
  assert.deepEqual(codes(withBody('const x = ctx["constructor"];')), ["denied_name:constructor"]);
  assert.deepEqual(codes(withBody("const x = ctx.books.get.constructor;")), ["denied_name:constructor"]);
  assert.ok(codes(withBody('const m = await import("node:fs");')).some((c) => c.startsWith("dynamic_import")));
  assert.ok(codes(`import fs from "node:fs";\n${GOOD}`).some((c) => c.startsWith("import_not_allowed")));
  assert.ok(codes(GOOD.replace("import { bookingOf, rank }", "import { bookingOf, rank, secretHelper }")).some((c) => c.startsWith("import_not_allowed")));
  assert.deepEqual(codes(withBody("const t = setTimeout(() => 0, 1);")), ["unknown_global:setTimeout"]);
  assert.deepEqual(checkAllowlist(withBody("const t = setTimeout(() => 0, 1);"), new Set(["setTimeout"])), [], "a global the bad file already used is not new");
  assert.ok(codes(`import { bookingOf } from "../lib/shop/events.ts";\n${GOOD}`).some((c) => c.startsWith("duplicate_binding")));
  assert.ok(codes(GOOD.replace("export const SOURCE = import.meta.url;", "export const SOURCE = import.meta.url + import.meta.dirname;")).some((c) => c.startsWith("import_meta_misuse")));
  assert.ok(codes(GOOD.replace("export const handleWebhook", "const handleWebhook")).some((c) => c.startsWith("missing_export")));
  assert.match(codes("export const handleWebhook = async (ctx => {")[0], /^syntax_error:/);
});

test("the check rows say which check failed: a patch that does not parse, one with a denied name, one that drops an uncited line", () => {
  const t = plantedTarget("bad_body");
  const bug = idOf(t, "add", "canonical(JSON.parse");
  const rows = (line: string) => Object.fromEntries(checkFix(t, new Set([bug]), [E("replace", bug, line)]).rows.map((r) => [r.id, r.ok]));
  assert.deepEqual(rows("  const event = JSON.parse(ctx.rawBody);"), { edits_valid: true, parses: true, allowlist: true, uncited_kept: true, inside_hunks: true });
  assert.deepEqual(rows("  const event = JSON.parse(ctx.rawBody"), { edits_valid: true, parses: false, allowlist: false, uncited_kept: true, inside_hunks: true });
  assert.deepEqual(rows("  const event = JSON.parse(process.env.X);"), { edits_valid: true, parses: true, allowlist: false, uncited_kept: true, inside_hunks: true });
});

test("keep the feature: a patch that drops or alters an uncited line of the deploy is caught whatever built it", () => {
  const t = targetOf(GOOD, MIXED_BAD, "handlers/webhook.ts");
  const cited = new Set([idOf(t, "add", "void ctx.books.set")]);
  assert.deepEqual(keptUncited(t.bad, applyEdits(t.bad, t.index, []), t.index, cited), []);
  assert.equal(keptUncited(t.bad, t.bad.replace('  console.log("booked", booking.captureId);\n', ""), t.index, cited)[0].code, "uncited_line_changed");
  assert.equal(keptUncited(t.bad, t.bad.replace("booked", "paid"), t.index, cited)[0].code, "uncited_line_changed");
});

test("the tamper helper changes exactly one amount and keeps the body shaped like a booking", () => {
  const raw = JSON.stringify(completedEvent("CAPTUREABCDEF123", "48.00"));
  const t = tamper(raw);
  assert.notEqual(t, raw);
  assert.equal(raw.length, t.length);
  assert.equal(JSON.parse(t).resource.amount.value, "49.00");
  assert.throws(() => tamper('{"id":"x"}'), /no amount/);
});

test("verify answers are remembered per delivery and exact body; an unseen body without a live verifier is refused", async () => {
  const w = world(1);
  const v = new CachedVerifier(w.paypal.verify);
  const d = w.scenarios[0].deliveries[0];
  const p = { authAlgo: d.headers.authAlgo, certUrl: d.headers.certUrl, transmissionId: d.headers.transmissionId, transmissionSig: d.headers.transmissionSig, transmissionTime: d.headers.transmissionTime, webhookId: d.webhookId, webhookEvent: JSON.parse(d.raw) };
  assert.equal(await v.verify(p), "SUCCESS");
  assert.equal(await v.verify(p), "SUCCESS");
  assert.deepEqual(v.stats, { live: 1, cached: 1 });
  assert.equal(w.paypal.state.calls, 1);
  const offline = new CachedVerifier(undefined);
  await assert.rejects(() => offline.verify(p), /no live verify/);
});

test("when PayPal cannot be asked, the candidate is not judged (infra), it does not fail", async () => {
  const w = world(1);
  const ref = new Referee(w.scenarios, GOOD, new CachedVerifier(w.paypal.verify));
  await ref.prepare();
  // A candidate that asks about a body PayPal has not been asked about, while PayPal is down.
  const newQuestion = GOOD.replace("await ctx.verify(event)", 'await ctx.verify({ ...event, extra: "never asked" })');
  w.paypal.state.mode = "timeout";
  const r = await ref.judge(newQuestion);
  assert.equal(r.pass, false);
  assert.equal(r.infra?.reason, "verify_unavailable");
  // And a referee cannot even be set up without PayPal's answers for the good build.
  const cold = new Referee(w.scenarios, GOOD, new CachedVerifier(w.paypal.verify));
  await assert.rejects(() => cold.prepare(), /PayPal could not be asked/);
});

test("code that does not load or never finishes is a failure of the code, not of the infrastructure", async () => {
  const ref = await referee();
  const r = await ref.judge("export const handleWebhook = async () => { return { status: 200 }; };\nexport const SOURCE = import.meta.url;\nthis is not code");
  assert.equal(r.pass, false);
  assert.ok(r.codeFailure, JSON.stringify(r));
  assert.equal(r.infra, undefined);
});

test("an order the good build itself does not satisfy is dropped, not held against the patch", async () => {
  const w = world(2);
  w.scenarios[1].truth = "paid"; // PayPal's answer says paid, the good build books refunded: the control would mean nothing on this order
  const ref = new Referee(w.scenarios, GOOD, new CachedVerifier(w.paypal.verify));
  await ref.prepare();
  assert.equal(ref.scenarioCount, 1);
  assert.equal(ref.dropped.length, 1);
  assert.match(ref.dropped[0].why, /PayPal says paid/);
  assert.ok((await ref.judge(GOOD)).pass);
});
