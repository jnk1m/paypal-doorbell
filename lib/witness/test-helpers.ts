// Shared by the witness tests: the real Sandbox deliveries in fixtures/witness, a request builder and a stand-in for PayPal's verify endpoint.
import { readFileSync } from "node:fs";
import { PaypalError, type VerifyParams } from "../pay/paypal.ts";

export const TEST_WEBHOOK_ID = "WH-FIXTURE-WITNESS-0001";
export const OTHER_WEBHOOK_ID = "WH-FIXTURE-SOMEONE-ELSE";

export interface Delivery {
  at: number;
  headers: Record<string, string>;
  raw: string;
}

interface Fixture {
  retry: Delivery[]; // three attempts of one transmission id
  singles: Delivery[]; // three different deliveries
}

export const fixture: Fixture = JSON.parse(readFileSync(new URL("../../fixtures/witness/deliveries.json", import.meta.url), "utf8"));

export const tidOf = (d: Delivery) => d.headers["paypal-transmission-id"];

// A POST like PayPal's. headers: a value replaces a header, null removes it. raw replaces the body.
export function requestOf(d: Delivery, over: { headers?: Record<string, string | null>; raw?: string } = {}): Request {
  const headers = new Headers(d.headers);
  for (const [k, v] of Object.entries(over.headers ?? {})) {
    if (v === null) headers.delete(k);
    else headers.set(k, v);
  }
  return new Request("https://doorbell.test/api/witness", { method: "POST", headers, body: over.raw ?? d.raw });
}

// Flips one base64 character in the middle of the signature: still well-formed, no longer valid.
export const tamperSignature = (sig: string, at = 40): string => sig.slice(0, at) + (sig[at] === "A" ? "B" : "A") + sig.slice(at + 1);

// A well-formed delivery with a made-up signature and a fresh transmission id.
export function forgedDelivery(n: number): Delivery {
  const base = fixture.singles[0];
  const tid = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return {
    at: Date.now(),
    headers: { ...base.headers, "paypal-transmission-id": tid, "paypal-transmission-sig": Buffer.alloc(256, n % 251).toString("base64") },
    raw: base.raw,
  };
}

export type VerifyMode = "ok" | "timeout" | "http500" | "http503" | "http400" | "weird";

// What PayPal's verify endpoint answers, as far as the receiver cares: SUCCESS only for a delivery PayPal really signed, for the
// webhook it was signed for; FAILURE for anything else. mode injects the failures of the verify call itself.
export function fakePaypal(known: { delivery: Delivery; webhookId?: string }[]) {
  const state = { calls: 0, mode: "ok" as VerifyMode, params: [] as VerifyParams[] };
  const verify = async (p: VerifyParams): Promise<string | undefined> => {
    state.calls++;
    state.params.push(p);
    switch (state.mode) {
      case "timeout":
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      case "http500":
        throw new PaypalError("verify webhook signature", 500, "dbg", { name: "INTERNAL_SERVER_ERROR" });
      case "http503":
        throw new PaypalError("verify webhook signature", 503, "dbg", undefined);
      case "http400":
        throw new PaypalError("verify webhook signature", 400, "dbg", { name: "INVALID_REQUEST" });
      case "weird":
        return "PENDING";
    }
    const match = known.find(
      ({ delivery: d }) =>
        tidOf(d) === p.transmissionId &&
        d.headers["paypal-transmission-time"] === p.transmissionTime &&
        d.headers["paypal-transmission-sig"] === p.transmissionSig &&
        JSON.stringify(JSON.parse(d.raw)) === JSON.stringify(p.webhookEvent),
    );
    return match && (match.webhookId ?? TEST_WEBHOOK_ID) === p.webhookId ? "SUCCESS" : "FAILURE";
  };
  return { verify, state };
}
