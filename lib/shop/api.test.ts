import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../web/http.ts";
import { readJson, requireLiveToken, requireSameOrigin, requireSession } from "./api.ts";
import { MemoryShopStore } from "./store.ts";

const req = (headers: Record<string, string> = {}, body?: string) => new Request("https://doorbell.test/api/shop/order", { method: "POST", headers, body });
const status = (fn: () => unknown): number | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof HttpError ? e.status : -1;
  }
};

test("the live shop is closed without a token configured, and with a wrong or missing token", () => {
  assert.equal(status(() => requireLiveToken(req({ "x-live-token": "anything" }), undefined)), 403, "no token configured: closed, not open");
  assert.equal(status(() => requireLiveToken(req({ "x-live-token": "anything" }), "")), 403);
  assert.equal(status(() => requireLiveToken(req(), "secret-token")), 403);
  assert.equal(status(() => requireLiveToken(req({ "x-live-token": "secret-tokeX" }), "secret-token")), 403);
  assert.equal(status(() => requireLiveToken(req({ "x-live-token": "secret" }), "secret-token")), 403);
  assert.equal(status(() => requireLiveToken(req({ "x-live-token": "secret-token" }), "secret-token")), undefined);
});

test("a browser request must come from this site; a request without Origin (a script) passes this check", () => {
  assert.equal(status(() => requireSameOrigin(req({ origin: "https://evil.example", host: "doorbell.test" }))), 403);
  assert.equal(status(() => requireSameOrigin(req({ origin: "not a url", host: "doorbell.test" }))), 403);
  assert.equal(status(() => requireSameOrigin(req({ origin: "https://doorbell.test", host: "doorbell.test" }))), undefined);
  assert.equal(status(() => requireSameOrigin(req({ origin: "https://doorbell.test", "x-forwarded-host": "doorbell.test", host: "internal:3000" }))), undefined);
  assert.equal(status(() => requireSameOrigin(req())), undefined);
});

test("a session header must be 128 random bits that the server created", async () => {
  const store = new MemoryShopStore();
  const sid = "0123456789abcdef0123456789abcdef";
  await store.createSession(sid, "good", 1);
  await assert.rejects(requireSession(req({}), store), (e: HttpError) => e.status === 400);
  await assert.rejects(requireSession(req({ "x-session": "short" }), store), (e: HttpError) => e.status === 400);
  await assert.rejects(requireSession(req({ "x-session": "f".repeat(32) }), store), (e: HttpError) => e.status === 404);
  assert.deepEqual(await requireSession(req({ "x-session": sid }), store), { sid, mode: "good", at: 1 });
});

test("a request body is JSON object under 2 KB or a 400 whose message says nothing about it", async () => {
  assert.deepEqual(await readJson(req({}, '{"item":"gift-set"}')), { item: "gift-set" });
  for (const body of ["", "nope", "[1]", "null", JSON.stringify({ x: "y".repeat(3000) })]) {
    await assert.rejects(readJson(req({}, body)), (e: HttpError) => e.status === 400 && e.message === "Bad request.");
  }
});
