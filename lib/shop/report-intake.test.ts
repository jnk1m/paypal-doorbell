// A24, the path for a shop of your own (plan 5.7, R24): forged reports are refused and change nothing, a genuine report from the HTTP
// reporter lands as the in-process reporter's would, "arrived and then crashed" and "never arrived" are told apart over HTTP as well,
// the reporter never throws at the shop, and the intake is closed without a secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { HttpReporter } from "./http-reporter.ts";
import { handleReport, isIntakeOpen, REPORT_ACCEPTED_BODY, REPORT_CLOSED_BODY, REPORT_REFUSED_BODY } from "./report-intake.ts";
import { HEADER_NONCE, HEADER_SIGNATURE, HEADER_TIMESTAMP, MAX_REPORT_BYTES, MAX_SKEW_MS, parseReportLine, signReport } from "./report-signature.ts";
import { CRASH_AFTER_MS, InProcessReporter, summarizeReport } from "./reporter.ts";
import { MemoryShopStore } from "./store.ts";

// Test values built here, not literal, so that no secret scanner mistakes them for keys (the export runs gitleaks).
const SECRET = "x".repeat(40);
const OTHER_SECRET = "y".repeat(40);
const INTAKE = "https://doorbell.test/api/report";
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const nonce = () => randomBytes(16).toString("hex");
const attemptId = () => randomBytes(6).toString("hex");

// Counts the database-shaped calls, so a test can say what a request cost.
class CountingStore extends MemoryShopStore {
  calls = { append: 0, nonce: 0 };
  override async appendReport(eid: string, line: string): Promise<void> {
    this.calls.append++;
    return super.appendReport(eid, line);
  }
  override async claimReportNonce(n: string, ttlMs: number): Promise<boolean> {
    this.calls.nonce++;
    return super.claimReportNonce(n, ttlMs);
  }
}

interface Forgery {
  secret?: string;
  timestamp?: number;
  nonce?: string;
  signedBody?: string; // what the signature was computed over, when it is not the body sent
  signature?: string;
  contentType?: string;
  omitHeaders?: boolean;
}

function request(body: string, f: Forgery = {}): Request {
  const timestamp = f.timestamp ?? NOW;
  const n = f.nonce ?? nonce();
  const headers: Record<string, string> = { "Content-Type": f.contentType ?? "application/json" };
  if (!f.omitHeaders) {
    headers[HEADER_TIMESTAMP] = String(timestamp);
    headers[HEADER_NONCE] = n;
    headers[HEADER_SIGNATURE] = f.signature ?? signReport(f.secret ?? SECRET, timestamp, n, f.signedBody ?? body);
  }
  return new Request(INTAKE, { method: "POST", headers, body });
}

const rx = (eid: string, tid = "tid-00000001", a = attemptId()) => JSON.stringify({ k: "rx", tid, eid, a });
const rs = (eid: string, st: number, tid = "tid-00000001", a = attemptId()) => JSON.stringify({ k: "rs", tid, eid, a, st });

const world = () => {
  const store = new CountingStore(() => NOW);
  const deps = { secret: SECRET, store, now: () => NOW, log: () => undefined };
  const post = (req: Request) => handleReport(req, deps);
  // An HttpReporter whose fetch is the intake itself: the client and the server speak through the real protocol, with no socket.
  const reporter = (over: Partial<ConstructorParameters<typeof HttpReporter>[0]> = {}) =>
    new HttpReporter({ url: INTAKE, secret: SECRET, now: () => NOW, fetch: (input, init) => post(new Request(input, init)), onError: () => undefined, ...over });
  return { store, deps, post, reporter };
};

test("A24 (your own shop): 10 forged reports are refused with one fixed body, leave no record, and only the replay of a genuine report costs a database command", async () => {
  const { store, post } = world();
  const genuine = rx("WH-GENUINE-00001");
  const genuineNonce = nonce();
  assert.equal((await post(request(genuine, { nonce: genuineNonce }))).status, 200);

  const forgeries: [string, Request][] = [
    ["no Doorbell headers", request(rx("WH-FORGED-00001"), { omitHeaders: true })],
    ["wrong secret", request(rx("WH-FORGED-00002"), { secret: OTHER_SECRET })],
    ["body changed after signing (401 became 200)", request(rs("WH-FORGED-00003", 200), { signedBody: rs("WH-FORGED-00003", 401) })],
    ["timestamp 5 minutes and 1 second in the past", request(rx("WH-FORGED-00004"), { timestamp: NOW - MAX_SKEW_MS - 1000 })],
    ["timestamp 5 minutes and 1 second in the future", request(rx("WH-FORGED-00005"), { timestamp: NOW + MAX_SKEW_MS + 1000 })],
    ["replay of the genuine report (same nonce, same signature)", request(genuine, { nonce: genuineNonce })],
    ["content type text/plain", request(rx("WH-FORGED-00007"), { contentType: "text/plain" })],
    ["body over the size limit, correctly signed", request(JSON.stringify({ k: "rx", tid: "tid-00000001", eid: "WH-FORGED-00008", a: attemptId(), pad: "x".repeat(MAX_REPORT_BYTES) }))],
    ["malformed event id, correctly signed", request(rx("WH FORGED 00009"))],
    ["status code 999, correctly signed", request(rs("WH-FORGED-00010", 999))],
  ];
  for (const [what, req] of forgeries) {
    const res = await post(req);
    assert.equal(res.status, 401, what);
    assert.equal(await res.text(), REPORT_REFUSED_BODY, what);
  }

  const forgedEids = ["WH-FORGED-00001", "WH-FORGED-00002", "WH-FORGED-00003", "WH-FORGED-00004", "WH-FORGED-00005", "WH-FORGED-00007", "WH-FORGED-00008", "WH FORGED 00009", "WH-FORGED-00010"];
  assert.deepEqual(await store.reports(forgedEids), forgedEids.map(() => null), "no forgery left a record");
  const [record] = await store.reports(["WH-GENUINE-00001"]);
  assert.equal(record?.split("\n").filter(Boolean).length, 1, "the replay did not add a second line to the genuine record");
  assert.deepEqual(store.calls, { append: 1, nonce: 2 }, "the genuine report cost one nonce check and one append; of the 10 forgeries only the replay reached the nonce check");
});

test("A24 (your own shop): a received/responded pair from the HTTP reporter lands as the in-process reporter's record would", async () => {
  const { store, reporter } = world();
  const r = reporter();
  const attempt = await r.received("tid-00000002", "WH-HTTP-0000001");
  await r.responded("tid-00000002", 200, attempt);

  const inProcess = new InProcessReporter(store, () => NOW);
  const attempt2 = await inProcess.received("tid-00000002", "WH-INPROC-00001");
  await inProcess.responded("tid-00000002", 200, attempt2);

  const [overHttp, inProc] = await store.reports(["WH-HTTP-0000001", "WH-INPROC-00001"]);
  const keysOf = (record: string | null) => record!.split("\n").filter(Boolean).map((l) => Object.keys(JSON.parse(l)).sort().join(","));
  assert.deepEqual(keysOf(overHttp), keysOf(inProc), "same line shapes");
  assert.deepEqual(summarizeReport(overHttp, NOW)?.map((a) => [a.tid, a.state, a.status, a.receivedAt, a.respondedAt]), [["tid-00000002", "responded", 200, NOW, NOW]]);
  assert.equal(store.calls.append, 4);
});

test("A24 (your own shop): over HTTP, five handlers that die after received() are 'crashed' and five that never ran are 'no record'", async () => {
  const { store, reporter } = world();
  const r = reporter();
  const died: string[] = [];
  const never: string[] = [];
  for (let i = 0; i < 5; i++) {
    const eid = `WH-DIED-000000${i}`;
    await r.received(`tid-died-0000${i}`, eid); // and then the process is killed: no responded()
    died.push(eid);
    never.push(`WH-NEVER-00000${i}`);
  }
  const records = await store.reports([...died, ...never]);
  for (const [i, record] of records.entries()) {
    const view = summarizeReport(record, NOW + CRASH_AFTER_MS + 1000);
    if (i < 5) assert.deepEqual(view?.map((a) => a.state), ["crashed"], `${died[i]} arrived and was never answered`);
    else assert.equal(view, null, `${never[i - 5]} never arrived`);
  }
});

test("A24 (your own shop): the intake is closed without a secret, or with a short one: 404, one fixed body, nothing read or written", async () => {
  const store = new CountingStore(() => NOW);
  const genuine = request(rx("WH-CLOSED-000001"));
  for (const deps of [{ store }, { secret: "s".repeat(31), store }, { secret: SECRET }]) {
    assert.equal(isIntakeOpen(deps), false);
    const res = await handleReport(genuine.clone(), { ...deps, now: () => NOW, log: () => undefined });
    assert.equal(res.status, 404);
    assert.equal(await res.text(), REPORT_CLOSED_BODY);
  }
  assert.deepEqual(store.calls, { append: 0, nonce: 0 });
  assert.deepEqual(await store.reports(["WH-CLOSED-000001"]), [null]);
  assert.equal(isIntakeOpen({ secret: SECRET, store }), true);
});

test("the HTTP reporter never throws at the shop: a Doorbell that is down, refusing or silent is reported to onError and the handler goes on", async () => {
  const errors: Record<string, unknown>[] = [];
  const down = new HttpReporter({ url: INTAKE, secret: SECRET, onError: (l) => errors.push(l), fetch: async () => { throw new Error("ECONNREFUSED"); } });
  const attempt = await down.received("tid-00000003", "WH-DOWN-0000001");
  assert.match(attempt.id, /^[0-9a-f]{12}$/);
  await down.responded("tid-00000003", 200, attempt);

  const refusing = new HttpReporter({ url: INTAKE, secret: SECRET, onError: (l) => errors.push(l), fetch: async () => new Response(REPORT_REFUSED_BODY, { status: 401 }) });
  await refusing.responded("tid-00000003", 200, attempt);

  const silent = new HttpReporter({
    url: INTAKE,
    secret: SECRET,
    timeoutMs: 20,
    onError: (l) => errors.push(l),
    fetch: (_input, init) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
  });
  await silent.responded("tid-00000003", 200, attempt);

  assert.deepEqual(
    errors.map((e) => [e.outcome, e.k, e.status]),
    [
      ["report_failed", "rx", undefined],
      ["report_failed", "rs", undefined],
      ["report_refused", "rs", 401],
      ["report_failed", "rs", undefined],
    ],
  );
});

test("the skew window is 5 minutes either way, inclusive; the accepted body is fixed", async () => {
  const { post } = world();
  for (const [timestamp, status] of [
    [NOW - MAX_SKEW_MS, 200],
    [NOW + MAX_SKEW_MS, 200],
    [NOW - MAX_SKEW_MS - 1, 401],
    [NOW + MAX_SKEW_MS + 1, 401],
  ] as const) {
    const res = await post(request(rx(`WH-SKEW-${String(timestamp).slice(-7)}`), { timestamp }));
    assert.equal(res.status, status, `timestamp ${timestamp - NOW} ms from now`);
    if (status === 200) assert.equal(await res.text(), REPORT_ACCEPTED_BODY);
  }
});

test("parseReportLine: exactly the two shapes, nothing more", () => {
  const a = attemptId();
  assert.deepEqual(parseReportLine(JSON.stringify({ k: "rx", tid: "tid-00000001", eid: "WH-1", a })), { k: "rx", tid: "tid-00000001", eid: "WH-1", a });
  assert.deepEqual(parseReportLine(JSON.stringify({ k: "rs", tid: "tid-00000001", eid: "WH-1", a, st: 401 })), { k: "rs", tid: "tid-00000001", eid: "WH-1", a, st: 401 });
  for (const bad of [
    JSON.stringify({ k: "rx", tid: "tid-00000001", eid: "WH-1", a, st: 200 }), // a status on a received line
    JSON.stringify({ k: "rs", tid: "tid-00000001", eid: "WH-1", a }), // no status on a responded line
    JSON.stringify({ k: "rx", tid: "tid-00000001", eid: "WH-1", a, at: 5 }), // the time is the intake's to set
    JSON.stringify({ k: "rs", tid: "tid-00000001", eid: "WH-1", a, st: "200" }),
    JSON.stringify({ k: "rx", tid: "short", eid: "WH-1", a }),
    JSON.stringify({ k: "rx", tid: "tid-00000001", eid: "WH-1", a: "not-hex-attempt" }),
    "[]",
    "null",
    "not json",
  ]) assert.equal(parseReportLine(bad), null, bad);
});
