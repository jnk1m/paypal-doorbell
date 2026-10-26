// The sandbox runs model-written handlers only in a child process with no environment, no network, no files and no eval. These tests run code
// the static checks would refuse, straight into the sandbox, and read what it could reach.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completedEvent, refundedEvent, signed } from "../shop/test-helpers.ts";
import { runSandboxed } from "./sandbox.ts";

const GOOD = readFileSync(new URL("../../handlers/good.ts", import.meta.url), "utf8");
const ok = async () => "SUCCESS";

const bodies = () => {
  const capture = "CAPTUREABCDEF123";
  return [signed(completedEvent(capture)).raw, signed(refundedEvent(capture, "REFUNDABCDEF123")).raw];
};

test("the good build runs in the sandbox: payment then refund books refunded; refund then payment still books refunded", async () => {
  const [c, r] = bodies();
  const res = await runSandboxed({ handlerTs: GOOD, runs: [[c, r], [r, c]], broker: ok });
  assert.ok(res.ok, JSON.stringify(res));
  assert.deepEqual(res.runs.map((x) => x.statuses), [[200, 200], [200, 200]]);
  for (const run of res.runs) assert.equal(run.books["CAPTUREABCDEF123"].state, "refunded");
  assert.deepEqual(res.runs[0].errors, []);
});

test("verify is answered by the parent, per delivery; a failure answer is a 401", async () => {
  const [c, r] = bodies();
  const asked: [number, number][] = [];
  const res = await runSandboxed({ handlerTs: GOOD, runs: [[c, r]], broker: async ({ run, delivery }) => (asked.push([run, delivery]), delivery === 0 ? "FAILURE" : "SUCCESS") });
  assert.ok(res.ok);
  assert.deepEqual(res.runs[0].statuses, [401, 200]);
  assert.deepEqual(asked, [[0, 0], [0, 1]]);
});

test("a broker that throws makes the handler throw (500), not the sandbox", async () => {
  const [c] = bodies();
  const res = await runSandboxed({ handlerTs: GOOD, runs: [[c]], broker: async () => { throw new Error("PayPal unreachable"); } });
  assert.ok(res.ok);
  assert.equal(res.runs[0].statuses[0], 500);
  assert.match(res.runs[0].errors[0], /PayPal unreachable/);
});

test("containment: no network, no files, no child process, no eval, no environment, no process object", async () => {
  const escape = join(tmpdir(), "doorbell-sandbox-escape.txt");
  const probe = `
export const SOURCE = "x";
export const handleWebhook = async (ctx) => {
  const r = {};
  const attempt = async (name, fn) => { try { r[name] = await fn(); } catch (e) { r[name] = "denied:" + (e && (e.code || e.name)); } };
  r.process = typeof process; r.fetch = typeof fetch; r.require = typeof require;
  await attempt("net", async () => { const net = await import("node:net"); return await new Promise((res, rej) => { const s = net.connect(443, "1.1.1.1"); s.on("connect", () => res("CONNECTED")); s.on("error", rej); }); });
  await attempt("fs", async () => (await import("node:fs")).readFileSync("/etc/hosts", "utf8").length);
  await attempt("fswrite", async () => (await import("node:fs")).writeFileSync(${JSON.stringify(escape)}, "x"));
  await attempt("cp", async () => (await import("node:child_process")).execSync("echo hi").toString());
  await attempt("worker", async () => new (await import("node:worker_threads")).Worker("1", { eval: true }));
  await attempt("evalString", async () => (0, eval)("1+1"));
  await attempt("newFunction", async () => new Function("return 1")());
  await attempt("env", async () => { const p = (await import("node:process")).default; return Object.keys(p.env).join(","); });
  console.log(JSON.stringify(r));
  return { status: 200 };
};`;
  process.env.FIX_SANDBOX_CANARY_SECRET = "canary"; // a secret in the parent's environment must not reach the child
  const res = await runSandboxed({ handlerJs: probe, runs: [["{}"]], broker: ok });
  delete process.env.FIX_SANDBOX_CANARY_SECRET;
  assert.ok(res.ok, JSON.stringify(res));
  const seen = JSON.parse(res.runs[0].logs[0]) as Record<string, string>;
  assert.equal(seen.process, "undefined");
  assert.equal(seen.fetch, "undefined");
  assert.equal(seen.require, "undefined");
  for (const k of ["net", "fs", "fswrite", "cp", "worker"]) assert.match(seen[k], /^denied:ERR_ACCESS_DENIED/, `${k}: ${seen[k]}`);
  assert.equal(existsSync(escape), false);
  assert.match(seen.evalString, /^denied:/);
  assert.match(seen.newFunction, /^denied:/);
  assert.doesNotMatch(seen.env, /KEY|TOKEN|SECRET|PAYPAL|ANTHROPIC|KV_|REDIS|VERCEL/i, `the environment must hold no secret names, it holds: ${seen.env}`);
  // empty: macOS adds one locale hint to every process it starts, which is not ours and holds nothing
  assert.deepEqual(seen.env.split(",").filter((k) => k && k !== "__CF_USER_TEXT_ENCODING"), [], `environment: ${seen.env}`);
});

test("a handler that never returns is killed at the timeout and the call returns", async () => {
  const t0 = Date.now();
  const res = await runSandboxed({ handlerJs: `export const handleWebhook = async () => { for (;;) {} };`, runs: [["{}"]], broker: ok, timeoutMs: 1500 });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.reason, "timeout");
  assert.ok(Date.now() - t0 < 6000);
});

test("a module that does not import is reported, not run", async () => {
  const res = await runSandboxed({ handlerJs: `export const x = ;`, runs: [["{}"]], broker: ok });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.reason, "import_failed");
});

test("a write that is not awaited is lost when the handler answers (the function is frozen), an awaited one lands", async () => {
  const js = (awaited: boolean) => `export const SOURCE = "x";
export const handleWebhook = async (ctx) => {
  const w = ctx.books.set("C1", { state: "paid", amount: "1.00", eid: "e", at: 0 });
  ${awaited ? "await w;" : ""}
  return { status: 200 };
};`;
  const lost = await runSandboxed({ handlerJs: js(false), runs: [["{}"]], broker: ok });
  const kept = await runSandboxed({ handlerJs: js(true), runs: [["{}"]], broker: ok });
  assert.ok(lost.ok && kept.ok);
  assert.deepEqual(lost.runs[0].books, {});
  assert.equal(kept.runs[0].books["C1"].state, "paid");
});

test("a write deferred with setTimeout is lost too", async () => {
  const js = `export const handleWebhook = async (ctx) => { setTimeout(() => ctx.books.set("C1", { state: "paid", amount: "1.00", eid: "e", at: 0 }), 5); return { status: 200 }; };`;
  const res = await runSandboxed({ handlerJs: js, runs: [["{}", "{}"]], broker: ok });
  assert.ok(res.ok);
  assert.deepEqual(res.runs[0].books, {});
});

test("each run starts with empty books", async () => {
  const [c] = bodies();
  const res = await runSandboxed({ handlerTs: GOOD, runs: [[c], [c]], broker: ok });
  assert.ok(res.ok);
  assert.equal(Object.keys(res.runs[1].books).length, 1);
});
