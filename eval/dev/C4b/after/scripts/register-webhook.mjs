// Run after changing the public URL or the event list: node scripts/register-webhook.mjs
const BASE = "https://api-m.paypal.com";
const URL_ = "https://shop.example.com/api/paypal/webhook";
const EVENT_TYPES = [
  { name: "PAYMENT.CAPTURE.COMPLETED" },
  { name: "PAYMENT.CAPTURE.DENIED" },
];
const token = process.env.PAYPAL_ACCESS_TOKEN;
const res = await fetch(`${BASE}/v1/notifications/webhooks`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ url: URL_, event_types: EVENT_TYPES }),
});
console.log(res.status, await res.text());
