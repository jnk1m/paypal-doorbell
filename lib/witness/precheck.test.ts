import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHeaders, MAX_BODY_BYTES, parseEvent, readBodyCapped } from "./precheck.ts";
import { fixture, requestOf } from "./test-helpers.ts";

const real = fixture.singles[0];
const now = Date.parse("2026-10-19T00:00:00Z");
const headersWith = (over: Record<string, string | null>) => requestOf(real, { headers: over }).headers;

test("headers of a real Sandbox delivery pass", () => {
  const r = checkHeaders(requestOf(real).headers, now);
  assert.equal(r.ok, true);
});

test("a missing PayPal header is refused, each one", () => {
  for (const name of ["paypal-transmission-id", "paypal-transmission-time", "paypal-transmission-sig", "paypal-cert-url", "paypal-auth-algo"]) {
    const r = checkHeaders(headersWith({ [name]: null }), now);
    assert.equal(r.ok, false, name);
  }
});

test("cert_url must be exactly a Sandbox certificate URL: no other host, userinfo, port, query, fragment, scheme or path", () => {
  const good = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-bf9ab596";
  assert.equal(checkHeaders(headersWith({ "paypal-cert-url": good }), now).ok, true);
  assert.equal(checkHeaders(headersWith({ "paypal-cert-url": good.replace("api.sandbox", "api-m.sandbox") }), now).ok, true);
  for (const bad of [
    "https://api.paypal.com/v1/notifications/certs/CERT-1", // Live host
    "https://api.sandbox.paypal.com.evil.example/v1/notifications/certs/CERT-1",
    "https://evil.example/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com@evil.example/v1/notifications/certs/CERT-1",
    "https://evil.example@api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com:8443/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com:443/v1/notifications/certs/CERT-1",
    "http://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1?x=1",
    "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1#x",
    "https://api.sandbox.paypal.com/v1/notifications/certs/../../oauth2/token",
    "https://api.sandbox.paypal.com/v1/other/CERT-1",
    "https://api.sandbox.paypal.com\\@evil.example/v1/notifications/certs/CERT-1",
    "ftp://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "//api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  ]) {
    assert.equal(checkHeaders(headersWith({ "paypal-cert-url": bad }), now).ok, false, bad);
  }
});

test("auth_algo must be SHA256withRSA; ids and signatures must have the right shape", () => {
  assert.equal(checkHeaders(headersWith({ "paypal-auth-algo": "SHA1withRSA" }), now).ok, false);
  assert.equal(checkHeaders(headersWith({ "paypal-transmission-id": "a b" }), now).ok, false);
  assert.equal(checkHeaders(headersWith({ "paypal-transmission-id": "x".repeat(65) }), now).ok, false);
  assert.equal(checkHeaders(headersWith({ "paypal-transmission-sig": "short" }), now).ok, false);
  assert.equal(checkHeaders(headersWith({ "paypal-transmission-sig": "!".repeat(344) }), now).ok, false);
  assert.equal(checkHeaders(headersWith({ "content-type": "text/plain" }), now).ok, false);
});

test("transmission time: the past is accepted (retries reuse it), more than 5 minutes ahead is not", () => {
  assert.equal(checkHeaders(headersWith({ "paypal-transmission-time": "2020-01-01T00:00:00Z" }), now).ok, true);
  assert.equal(checkHeaders(headersWith({ "paypal-transmission-time": "2026-10-19T00:04:00Z" }), now).ok, true);
  assert.equal(checkHeaders(headersWith({ "paypal-transmission-time": "2026-10-19T00:06:00Z" }), now).ok, false);
  assert.equal(checkHeaders(headersWith({ "paypal-transmission-time": "yesterday" }), now).ok, false);
  assert.equal(checkHeaders(headersWith({ "paypal-transmission-time": "2026-13-45T99:99:99Z" }), now).ok, false);
});

test("the body is read up to 64 KB and no further", async () => {
  const ok = await readBodyCapped(new Request("https://x.test/", { method: "POST", body: "a".repeat(MAX_BODY_BYTES) }));
  assert.equal(ok.ok, true);
  const over = await readBodyCapped(new Request("https://x.test/", { method: "POST", body: "a".repeat(MAX_BODY_BYTES + 1) }));
  assert.equal(over.ok, false);
  const declared = await readBodyCapped(new Request("https://x.test/", { method: "POST", body: "a", headers: { "content-length": String(MAX_BODY_BYTES + 1) } }));
  assert.equal(declared.ok, false);
  assert.equal((await readBodyCapped(new Request("https://x.test/", { method: "POST" }))).ok, false);
});

test("the event must be a JSON object with a well-formed id and type", () => {
  assert.equal(parseEvent(real.raw).ok, true);
  for (const bad of ["not json", "[]", "null", '"x"', "{}", '{"id":"a b","event_type":"X.Y"}', '{"id":"WH-1","event_type":"lower.case"}', '{"id":1,"event_type":"A.B"}']) {
    assert.equal(parseEvent(bad).ok, false, bad);
  }
});
