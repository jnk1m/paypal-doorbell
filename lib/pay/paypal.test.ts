import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { PaypalClient, PaypalError, SANDBOX_BASE_URL } from "./paypal.ts";

const keys = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the client refuses to be built for any URL but Sandbox", () => {
  assert.throws(() => new PaypalClient({ clientId: "a", clientSecret: "b", baseUrl: "https://api-m.paypal.com" }), /Sandbox only/);
  assert.throws(() => PaypalClient.fromEnv({ ...keys, PAYPAL_BASE_URL: "https://api-m.paypal.com" }), /Sandbox only/);
  assert.doesNotThrow(() => PaypalClient.fromEnv({ ...keys }));
  assert.doesNotThrow(() => PaypalClient.fromEnv({ ...keys, PAYPAL_BASE_URL: SANDBOX_BASE_URL }));
});

test("missing keys fail at construction with a clear message", () => {
  assert.throws(() => PaypalClient.fromEnv({}), /PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
});

test("PaypalError messages carry the step, the status and error codes, never the debug id or free text", () => {
  const body = {
    name: "INVALID_REQUEST",
    message: "Request is not well-formed; value was 4111111111111111",
    debug_id: "abc123",
    details: [{ issue: "INVALID_STRING_LENGTH", description: "The value of a field is too long: secret-looking-value" }],
  };
  const err = new PaypalError("get capture", 400, "abc123", body);
  assert.equal(err.message, "get capture failed: HTTP 400 INVALID_REQUEST INVALID_STRING_LENGTH");
  assert.equal(err.debugId, "abc123");
  assert.deepEqual(err.codes, ["INVALID_REQUEST", "INVALID_STRING_LENGTH"]);
  assert.ok(!err.message.includes("abc123") && !err.message.includes("4111") && !err.message.includes("secret-looking"));
  assert.equal(new PaypalError("x", 503, undefined, "<html>Service Unavailable</html>").message, "x failed: HTTP 503");
  assert.equal(new PaypalError("x", 500, undefined, { name: "has spaces and text" }).message, "x failed: HTTP 500");
});

test("the access token is cached and requests carry it; only the Sandbox host is called", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") });
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const client = PaypalClient.fromEnv(keys);
  await client.request("a", "GET", "/v1/a");
  await client.request("b", "GET", "/v1/b");
  assert.equal(calls.filter((c) => c.url.endsWith("/v1/oauth2/token")).length, 1);
  assert.ok(calls.every((c) => c.url.startsWith(`${SANDBOX_BASE_URL}/`)));
  assert.deepEqual(calls.filter((c) => !c.url.endsWith("/v1/oauth2/token")).map((c) => c.auth), ["Bearer tok", "Bearer tok"]);
});

test("verifyWebhookSignature sends the delivery as PayPal expects and returns verification_status", async () => {
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
    assert.equal(url, `${SANDBOX_BASE_URL}/v1/notifications/verify-webhook-signature`);
    sent = JSON.parse(String(init?.body));
    return Response.json({ verification_status: "SUCCESS" });
  }) as typeof fetch;
  const status = await PaypalClient.fromEnv(keys).verifyWebhookSignature({
    authAlgo: "SHA256withRSA",
    certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    transmissionId: "t-1",
    transmissionSig: "sig",
    transmissionTime: "2026-10-18T14:30:19Z",
    webhookId: "WH-ID",
    webhookEvent: { id: "WH-1" },
  });
  assert.equal(status, "SUCCESS");
  assert.deepEqual(sent, {
    auth_algo: "SHA256withRSA",
    cert_url: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    transmission_id: "t-1",
    transmission_sig: "sig",
    transmission_time: "2026-10-18T14:30:19Z",
    webhook_id: "WH-ID",
    webhook_event: { id: "WH-1" },
  });
});

test("a non-2xx answer throws a PaypalError with the status", async () => {
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
    return Response.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404, headers: { "paypal-debug-id": "dbg1" } });
  }) as typeof fetch;
  await assert.rejects(PaypalClient.fromEnv(keys).request("get x", "GET", "/v1/x"), (e: unknown) => {
    assert.ok(e instanceof PaypalError);
    assert.equal(e.status, 404);
    assert.equal(e.debugId, "dbg1");
    assert.equal(e.message, "get x failed: HTTP 404 RESOURCE_NOT_FOUND");
    return true;
  });
});
