// R13 wiring: EVERY route of the live shop is behind the limiter, and the limiter runs BEFORE any Redis or PayPal work, so a refused request
// costs the database nothing. The folder app/api/shop/ is enumerated (there is no list of routes to keep up to date): a new route that lacks
// enforceLimit() fails here. The routes need Upstash to run, so this reads their source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "../cause/test-helpers.ts";
import { RULES } from "../limits.ts";

const SHOP = join(ROOT, "app/api/shop");

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (name === "route.ts") out.push(p);
  }
  return out;
}
const routes = routeFiles(SHOP).map((f) => ({ name: relative(SHOP, f).replace(/\/route\.ts$/, ""), src: readFileSync(f, "utf8").replace(/\/\/.*$/gm, "") }));

// The only routes without enforceLimit, each for a stated reason. Anything not listed here must have one.
const EXCEPTIONS: Record<string, string> = {
  webhook: "PayPal's own deliveries: the pre-check refuses a forgery before any Redis read, and a per-address limit would throttle PayPal itself",
  "case-u": "answers 200 and does nothing: no Redis, no PayPal",
  "snapshot/causes": "token only, and it touches neither Redis nor PayPal: it reads the recordings that ship with the deploy",
};

// What costs Redis commands or a PayPal call in these routes.
const WORK = ["requireSession(", "createSession(", "buildView(", "scanSession(", "buildLiveSnapshot(", "ringAgain(", "createOrder(", "refundOrder(", "store."];

test("the folder has the routes this test is about (enumerated, not listed)", () => {
  const names = routes.map((r) => r.name).sort();
  assert.ok(names.length >= 11, `found ${names.length}: ${names.join(", ")}`);
  for (const must of ["session", "order", "refund", "ring", "scan", "snapshot", "state", "mode", "webhook"]) assert.ok(names.includes(must), `${must} is a route`);
});

test("every route of app/api/shop calls enforceLimit with a real kind, after the origin and token checks and before any Redis or PayPal work, unless it is a listed exception", () => {
  const checked: string[] = [];
  for (const r of routes) {
    if (r.name in EXCEPTIONS) continue;
    checked.push(r.name);
    const m = /enforceLimit\("([a-z]+)"/.exec(r.src);
    assert.ok(m, `${r.name}: enforceLimit(...) is called`);
    assert.ok(m[1] in RULES, `${r.name}: "${m[1]}" is a kind of the limiter`);
    const at = m.index;
    const origin = r.src.indexOf("requireSameOrigin(req)");
    const token = r.src.indexOf("requireLiveToken(req");
    assert.ok(origin >= 0 && origin < at, `${r.name}: the same-origin check comes first`);
    assert.ok(token >= 0 && token < at, `${r.name}: the live token is checked first`);
    for (const w of WORK) {
      const i = r.src.indexOf(w);
      assert.ok(i === -1 || i > at, `${r.name}: ${w} comes after the limit`);
    }
  }
  assert.ok(checked.length >= 8, `${checked.length} routes checked: ${checked.join(", ")}`);
});

test("the exceptions are real routes, and the two that claim to touch nothing really import nothing that does", () => {
  const names = routes.map((r) => r.name);
  for (const e of Object.keys(EXCEPTIONS)) assert.ok(names.includes(e), `${e} is a route: remove stale exceptions`);
  for (const name of ["case-u", "snapshot/causes"]) {
    const src = routes.find((r) => r.name === name)!.src;
    assert.ok(!/shop\/config|shop\/store|redis|pay\/paypal|witness\/|shopApiFromEnv|gapsFromEnv/i.test(src), `${name} reaches neither Redis nor PayPal`);
  }
  assert.ok(routes.find((r) => r.name === "webhook")!.src.includes("handleShopDelivery"), "the webhook route goes through the delivery handler, which pre-checks and verifies");
});

test("ring: every press has its own per-session bucket, and only a resend that is really about to be sent counts against the pool shared with refunds", () => {
  const src = routes.find((r) => r.name === "ring")!.src;
  assert.ok(src.indexOf('enforceLimit("ring"') > 0 && src.indexOf('enforceLimit("ring"') < src.indexOf("requireSession("));
  assert.match(src, /ringAgain\([\s\S]*?beforeSend:\s*\(\)\s*=>\s*enforceLimit\("refund"/);
  assert.ok(!/^\s*await enforceLimit\("refund"/m.test(src), "no unconditional refund-pool count on a press");
});

test("the snapshot route checks the limit inside the 2 s coalescer, so a repeat inside the window costs nothing, and the session only after the limit", () => {
  const src = routes.find((r) => r.name === "snapshot")!.src;
  const run = src.indexOf("coalescer.run(");
  const limit = src.indexOf('enforceLimit("scan"');
  const session = src.indexOf("requireSession(");
  assert.ok(run > 0 && run < limit && limit < session);
});

test("state is a poll like the scan and counts on the scan's counters; mode is a write and has its own", () => {
  assert.match(routes.find((r) => r.name === "state")!.src, /enforceLimit\("scan"/);
  assert.match(routes.find((r) => r.name === "mode")!.src, /enforceLimit\("mode"/);
});
