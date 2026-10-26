import { test } from "node:test";
import assert from "node:assert/strict";
import { PaypalClient, PaypalError } from "../pay/paypal.ts";
import { listedOf, nextPagePath, PaypalClientReads } from "./reads.ts";

// A client whose HTTP layer is a script: it answers each request path from `answers` and records what was asked.
function scripted(answers: Record<string, unknown | Error>) {
  const asked: { method: string; path: string; body?: unknown; timeoutMs?: number }[] = [];
  const client = Object.create(PaypalClient.prototype) as PaypalClient;
  client.request = (async (_step: string, method: string, path: string, opts: { body?: unknown; timeoutMs?: number } = {}) => {
    asked.push({ method, path, body: opts.body, timeoutMs: opts.timeoutMs });
    const key = Object.keys(answers).find((k) => path.startsWith(k));
    if (!key) throw new PaypalError("scripted", 404, undefined, undefined);
    const a = answers[key];
    if (a instanceof Error) throw a;
    return a;
  }) as PaypalClient["request"];
  return { client, asked };
}

const refundedEntry = (eid: string, refundId: string, captureId: string, createTime = "2026-10-19T04:17:37.328Z") => ({
  id: eid,
  create_time: createTime,
  event_type: "PAYMENT.CAPTURE.REFUNDED",
  resource: { id: refundId, amount: { currency_code: "USD", value: "48.00" }, links: [{ rel: "self", href: `https://api.sandbox.paypal.com/v2/payments/refunds/${refundId}` }, { rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }] },
});

test("listedOf: an event of the list becomes (event id, type, creation time, resource, capture); anything malformed is dropped", () => {
  const e = refundedEntry("WH-50600904AE997010Y-79P71663YJ524670V", "0CJ781391P341682S", "5VH54830DK077121M");
  assert.deepEqual(listedOf(e), { eid: "WH-50600904AE997010Y-79P71663YJ524670V", type: "PAYMENT.CAPTURE.REFUNDED", createTime: Date.parse("2026-10-19T04:17:37.328Z"), resourceId: "0CJ781391P341682S", captureId: "5VH54830DK077121M" });
  assert.equal(listedOf({ ...e, id: "../../v1/oauth2/token" }), null, "an id that is not an event id never reaches a URL");
  assert.equal(listedOf({ ...e, create_time: "yesterday" }), null);
  assert.equal(listedOf({ ...e, event_type: "PAYMENT.CAPTURE.PENDING" }), null);
  assert.equal(listedOf(null), null);
});

test("nextPagePath: the next link is followed on our own base, and only when it names a Sandbox host and the events path", () => {
  const links = (href: string) => [{ rel: "self", href: "https://api.sandbox.paypal.com/x" }, { rel: "next", href }];
  assert.equal(nextPagePath(links("https://api.sandbox.paypal.com/v1/notifications/webhooks-events/?start_time=2026-09-19T04:30:54Z&page_size=5&move_to=next&offset=0&index_id=1")), "/v1/notifications/webhooks-events/?start_time=2026-09-19T04:30:54Z&page_size=5&move_to=next&offset=0&index_id=1");
  assert.equal(nextPagePath([{ rel: "self", href: "https://api.sandbox.paypal.com/x" }]), null);
  assert.equal(nextPagePath(undefined), null);
  for (const bad of ["https://evil.example/v1/notifications/webhooks-events/?a=1", "http://api.sandbox.paypal.com/v1/notifications/webhooks-events/", "https://api.sandbox.paypal.com.evil.example/v1/notifications/webhooks-events/", "https://user@api.sandbox.paypal.com/v1/notifications/webhooks-events/", "https://api.sandbox.paypal.com:8443/v1/notifications/webhooks-events/", "https://api.sandbox.paypal.com/v2/payments/captures/X", "not a url"]) {
    assert.throws(() => nextPagePath(links(bad)), /next link/, bad);
  }
});

test("listedEvents asks for both event types from a start time and follows pages; an unreadable page fails the whole list", async () => {
  const page1 = { events: [refundedEntry("WH-AAAAAAAAAA-BBBBBBBBBB", "REFUND0000001", "CAPTURE000001")], links: [{ rel: "next", href: "https://api.sandbox.paypal.com/v1/notifications/webhooks-events/?page=2&event_type=PAYMENT.CAPTURE.REFUNDED" }] };
  const page2 = { events: [refundedEntry("WH-CCCCCCCCCC-DDDDDDDDDD", "REFUND0000002", "CAPTURE000002"), { id: "junk" }], links: [] };
  const completed = { events: [], links: [] };
  const { client, asked } = scripted({
    "/v1/notifications/webhooks-events?page_size=100&start_time=2026-10-19T04:00:00Z&event_type=PAYMENT.CAPTURE.COMPLETED": completed,
    "/v1/notifications/webhooks-events?page_size=100&start_time=2026-10-19T04:00:00Z&event_type=PAYMENT.CAPTURE.REFUNDED": page1,
    "/v1/notifications/webhooks-events/?page=2": page2,
  });
  const found = await new PaypalClientReads(client).listedEvents(Date.parse("2026-10-19T04:00:00.789Z"), 5000);
  assert.deepEqual(found.map((e) => e.eid).sort(), ["WH-AAAAAAAAAA-BBBBBBBBBB", "WH-CCCCCCCCCC-DDDDDDDDDD"]);
  assert.equal(asked.length, 3);
  assert.ok(asked.every((a) => a.method === "GET" && a.timeoutMs === 5000));

  const broken = scripted({ "/v1/notifications/webhooks-events?page_size=100&start_time=2026-10-19T04:00:00Z&event_type=PAYMENT.CAPTURE.COMPLETED": completed, "/v1/notifications/webhooks-events?page_size=100&start_time=2026-10-19T04:00:00Z&event_type=PAYMENT.CAPTURE.REFUNDED": new PaypalError("list", 503, "dbg", undefined) });
  await assert.rejects(new PaypalClientReads(broken.client).listedEvents(Date.parse("2026-10-19T04:00:00Z"), 5000), /HTTP 503/);
});

test("ids are checked before they become part of a path: nothing is sent for a malformed capture, refund, event or webhook id", async () => {
  const { client, asked } = scripted({ "/": {} });
  const reads = new PaypalClientReads(client);
  await assert.rejects(reads.capture("../x", 1000), /malformed/);
  await assert.rejects(reads.refund("a/b/c/d/e/f/g", 1000), /malformed/);
  await assert.rejects(reads.resend("WH-OK-12345678", "../hook", 1000), /malformed/);
  await assert.rejects(reads.resend("x", "HOOK000000000001", 1000), /malformed/);
  await assert.rejects(reads.subscribedTypes("HOOK/../1", 1000), /malformed/);
  assert.deepEqual(asked, []);
});

test("resend posts the shop's webhook id only; subscribedTypes is asked once a minute", async () => {
  let t = 0;
  const { client, asked } = scripted({ "/v1/notifications/webhooks-events/WH-AAAAAAAAAA-BBBBBBBBBB/resend": {}, "/v1/notifications/webhooks/HOOK000000000001": { event_types: [{ name: "PAYMENT.CAPTURE.COMPLETED" }, { name: 7 }] } });
  const reads = new PaypalClientReads(client, () => t);
  await reads.resend("WH-AAAAAAAAAA-BBBBBBBBBB", "HOOK000000000001", 3000);
  assert.deepEqual(asked[0], { method: "POST", path: "/v1/notifications/webhooks-events/WH-AAAAAAAAAA-BBBBBBBBBB/resend", body: { webhook_ids: ["HOOK000000000001"] }, timeoutMs: 3000 });
  assert.deepEqual(await reads.subscribedTypes("HOOK000000000001", 1000), ["PAYMENT.CAPTURE.COMPLETED"]);
  t = 59_000;
  await reads.subscribedTypes("HOOK000000000001", 1000);
  assert.equal(asked.length, 2, "the second answer came from the cache");
  t = 61_000;
  await reads.subscribedTypes("HOOK000000000001", 1000);
  assert.equal(asked.length, 3);
});
