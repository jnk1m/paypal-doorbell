// Runs INSIDE the sandbox child (lib/fix/sandbox.ts starts it with `node --permission`: no network, no file reads outside its job directory,
// no file writes, no child processes, no workers, no eval from strings, and an empty environment). Plain JavaScript so that nothing needs a
// loader or a compiler in here.
//
//   argv: <nonce> <job.json>
//   stdout (to the parent): lines that start with the nonce, then JSON: {t:"verify", id, run, delivery, event} and, at the end, {t:"result", runs}
//   stdin  (from the parent): one JSON line per verify answer: {id, status} or {id, error}
//
// The handler under test gets the same HandlerContext as in the shop, built here: the raw body, verify (answered by the parent), books (in
// memory, one fresh Map per run) and now. A book write takes one macrotask to land, like a real database write, so a handler that returns
// without awaiting its write has not written when it returns; the books are read the moment the handler's promise settles, which is how a
// serverless function that is frozen right after its response behaves.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const proc = process;
const nonce = proc.argv[2];
const job = JSON.parse(readFileSync(proc.argv[3], "utf8"));
const out = (obj) => proc.stdout.write(`${nonce}${JSON.stringify(obj)}\n`);
const realSetTimeout = globalThis.setTimeout;
const tick = () => new Promise((resolve) => realSetTimeout(resolve, 0));

// Verify answers from the parent.
const waiting = new Map();
createInterface({ input: proc.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  const w = waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id);
  if (m.error !== undefined) w.reject(new Error(String(m.error)));
  else w.resolve(m.status ?? undefined);
});
let nextId = 1;
const askVerify = (run, delivery, event) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    out({ t: "verify", id, run, delivery, event: event === undefined ? null : event });
  });

// What the handler can no longer reach by name. (The permission model is the real wall; this only removes the easy ways.)
let logs = [];
const quiet = (...args) => {
  if (logs.length < 40) logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ").slice(0, 2000));
};
for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = quiet;
for (const k of ["process", "fetch", "WebSocket", "EventSource", "XMLHttpRequest", "WebAssembly", "SharedArrayBuffer", "Atomics", "Buffer", "queueMicrotask", "structuredClone", "setImmediate", "Worker", "BroadcastChannel", "MessageChannel"]) {
  try {
    delete globalThis[k];
  } catch {
    /* not deletable: the permission model still applies */
  }
}

let handler;
try {
  handler = await import(pathToFileURL(job.handlerPath).href);
  if (typeof handler.handleWebhook !== "function") throw new Error("the module does not export handleWebhook");
} catch (e) {
  out({ t: "result", importError: String(e?.message ?? e).slice(0, 300), runs: [] });
  proc.exit(0);
}

const results = [];
for (let r = 0; r < job.runs.length; r++) {
  const books = new Map();
  const statuses = [];
  const errors = [];
  logs = [];
  let clock = 1_000_000;
  for (let d = 0; d < job.runs[r].length; d++) {
    // One delivery is one invocation: when its handler has answered, the invocation is frozen and a write that has not landed is lost.
    let alive = true;
    const ctx = {
      rawBody: job.runs[r][d],
      verify: (event) => askVerify(r, d, event),
      books: {
        get: async (id) => {
          await tick();
          const e = books.get(id);
          return e === undefined ? null : { ...e };
        },
        set: async (id, entry) => {
          await tick();
          if (alive) books.set(id, { ...entry });
        },
      },
      now: () => clock++,
    };
    try {
      const res = await Promise.race([handler.handleWebhook(ctx), new Promise((_, reject) => realSetTimeout(() => reject(new Error("handler took longer than 8 s")), 8000))]);
      const status = res && typeof res === "object" ? res.status : undefined;
      statuses.push(Number.isInteger(status) ? status : 500);
      if (!Number.isInteger(status)) errors.push("the handler did not return { status }");
    } catch (e) {
      statuses.push(500);
      errors.push(String(e?.message ?? e).slice(0, 200));
    } finally {
      alive = false;
    }
  }
  // Frozen now: whatever a handler left pending can no longer change the books.
  const snapshot = {};
  for (const [id, e] of books) snapshot[id] = { state: e.state, amount: e.amount, eid: e.eid };
  results.push({ statuses, errors, books: snapshot, logs });
}
out({ t: "result", runs: results });
proc.exit(0);
