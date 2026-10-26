// The body of PayPal's Sandbox-only "process chargeback" call (POST /v2/customer-support/process-chargeback), which is how a test dispute is made on a
// Sandbox capture (https://developer.paypal.com/disputes/test-go-live). It is TEST INPUT: nothing in the product sends it. Only
// scripts/record-run.ts does, once, for the recorded run "dispute_never_heard", with the demo app's keys. This module builds the body and nothing else
// (no request is made here), so that what is sent is tested.
//
// Measured on 2026-10-20 (docs/measurements/disputes-probe-2026-10-20.json, 5 chargebacks): the call answers 2xx with a dispute id; the disputes API lists
// the dispute 39 to 100 s later; the dispute's seller transaction id is the capture id; `response_date` is where the dispute's seller_response_due_date
// comes from (we asked for +10 days; PayPal wrote the end of that day in its own time zone, 2026-10-31T03:59:59Z for a request on 10-30).
import { RESOURCE_ID } from "../gaps/reads.ts";

export interface ChargebackInput {
  merchantId: string; // the order's payee.merchant_id (GET /v2/checkout/orders/{id})
  captureId: string; // the capture to charge back
  amount: string; // "48.00": what the capture was
  at: number; // ms; the time of the call
  respondWithinDays: number; // becomes the dispute's seller_response_due_date
  digits: (n: number) => string; // n random digits (the card transaction id and the processor's reference number)
}

const MERCHANT_ID = /^[A-Z0-9]{10,20}$/;
const AMOUNT = /^\d{1,9}\.\d{2}$/;
const DAY_MS = 24 * 3_600_000;

export function chargebackBody(i: ChargebackInput) {
  if (!MERCHANT_ID.test(i.merchantId)) throw new Error("chargeback: the merchant id is malformed");
  if (!RESOURCE_ID.test(i.captureId)) throw new Error("chargeback: the capture id is malformed");
  if (!AMOUNT.test(i.amount)) throw new Error(`chargeback: the amount "${i.amount}" is not money`);
  if (!Number.isInteger(i.respondWithinDays) || i.respondWithinDays < 1 || i.respondWithinDays > 30) throw new Error(`chargeback: respondWithinDays ${i.respondWithinDays} is not 1 to 30`);
  const at = new Date(i.at).toISOString();
  return {
    adjacency: "PAYPAL",
    file_layout: "ATCK_CB",
    merchant_id: i.merchantId,
    financial_institution: { processor: "FDMS" },
    transaction: { id_enc: i.captureId, amount: { currency_code: "USD", value: i.amount } },
    instrument: { instrument_type: "CARD", card_brand: "VISA", credit_card_transaction_id: i.digits(16), external: false },
    dispute: {
      id: null,
      stage: "CHARGEBACK",
      response_date: new Date(i.at + i.respondWithinDays * DAY_MS).toISOString(),
      status: "2",
      amount: { currency_code: "USD", value: i.amount },
      receive_date: at,
      event_code: "CHARGEBACK_INITIATED",
      money_movement_date: at,
      event_type: "DEBIT",
      chargeback_type: "REPORTED_TO_PROCESSOR",
      processor_info: { reference_number: i.digits(23), reason_code: "1330", notes: "TEST_MEMO" },
    },
  };
}
