// Runs a handler that a model wrote, and never in this process. The handler goes into a child Node process that has
//   - an EMPTY environment (no keys, no tokens, nothing),
//   - `--permission` with no allowances except reading its own job directory: no network, no other file reads, no file writes,
//     no child processes, no workers, no native addons, no WASI,
//   - `--disallow-code-generation-from-strings` (no eval, no new Function),
// and gets only the handler context (sandbox-child.mjs builds it): the raw body, books held in memory, the clock, and `verify`, which the
// PARENT answers (from stored answers or from PayPal's verify endpoint). The handler's source is TypeScript text that is compiled here with
// the TypeScript API (types erased, imports pointed at the one helper module a handler may use); the child loads plain JavaScript only.
//
// Nothing model-written is ever evaluated, imported or written to handlers/ in the main process.
//
// LOCAL ONLY: scripts/record-fix.ts and scripts/record-run.ts are the callers; a deployed function never imports this file (recorded.test.ts checks
// the import graph). It needs a Node whose permission model has the stable `--permission` flag (22.13+ / 23.5+); it was built and tested on 26.8.2,
// where the model also denies network access. The empty environment shows one entry on macOS (__CF_USER_TEXT_ENCODING, a locale hint that the
// system adds to every process); sandbox.test.ts asserts there is nothing else.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const CHILD_RUNNER = new URL("./sandbox-child.mjs", import.meta.url).pathname;
const EVENTS_TS = new URL("../shop/events.ts", import.meta.url).pathname;

export const SANDBOX_FLAGS = ["--permission", "--disallow-code-generation-from-strings", "--max-old-space-size=96"] as const;

export interface RunOutcome {
  statuses: number[];
  errors: string[];
  books: Record<string, { state: string; amount: string; eid: string }>;
  logs: string[];
}

export type VerifyRequest = { run: number; delivery: number; event: unknown };
export type VerifyBroker = (req: VerifyRequest) => Promise<string | undefined>;

export type SandboxResult = { ok: true; runs: RunOutcome[] } | { ok: false; reason: "import_failed" | "timeout" | "crashed" | "protocol" | "output_too_large"; detail: string };

export interface SandboxJob {
  /** The handler as TypeScript text (the file under test). */
  handlerTs?: string;
  /** Or as ready JavaScript (tests of the sandbox itself use this to run code that the static checks would refuse). */
  handlerJs?: string;
  /** One list of raw bodies per run; each run starts with empty books. */
  runs: string[][];
  broker: VerifyBroker;
  timeoutMs?: number;
}

// TypeScript -> JavaScript, imports of the shop helper pointed at the copy that sits next to the handler in the job directory.
export function compileHandler(ts_: string): string {
  const out = ts.transpileModule(ts_, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return out.outputText.replaceAll('"../lib/shop/events.ts"', '"./events.mjs"');
}

function compileEvents(): string {
  const out = ts.transpileModule(readFileSync(EVENTS_TS, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return out.outputText;
}

export function sandboxRoot(): string {
  const base = process.env.FIX_SANDBOX_TMP ?? tmpdir();
  mkdirSync(base, { recursive: true });
  return realpathSync(base);
}

const MAX_STDOUT_BYTES = 8_000_000;

export async function runSandboxed(job: SandboxJob): Promise<SandboxResult> {
  const js = job.handlerJs ?? (job.handlerTs !== undefined ? compileHandler(job.handlerTs) : undefined);
  if (js === undefined) throw new Error("runSandboxed: give handlerTs or handlerJs");
  const dir = mkdtempSync(join(sandboxRoot(), "doorbell-fix-"));
  const nonce = `@@${randomBytes(12).toString("hex")}@@`;
  try {
    writeFileSync(join(dir, "handler.mjs"), js);
    writeFileSync(join(dir, "events.mjs"), compileEvents());
    writeFileSync(join(dir, "runner.mjs"), readFileSync(CHILD_RUNNER));
    writeFileSync(join(dir, "job.json"), JSON.stringify({ handlerPath: join(dir, "handler.mjs"), runs: job.runs }));

    const child = spawn(process.execPath, [...SANDBOX_FLAGS, `--allow-fs-read=${dir}`, join(dir, "runner.mjs"), nonce, join(dir, "job.json")], { cwd: dir, env: {} as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-600)));

    return await new Promise<SandboxResult>((resolve) => {
      let done = false;
      let bytes = 0;
      let buffer = "";
      const finish = (r: SandboxResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.kill("SIGKILL"); // our own child
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, reason: "timeout", detail: `no result within ${job.timeoutMs ?? 60_000} ms` }), job.timeoutMs ?? 60_000);

      const handleLine = async (line: string) => {
        if (!line.startsWith(nonce)) return; // anything else on stdout is not protocol
        let msg: { t?: string; id?: number; run?: number; delivery?: number; event?: unknown; runs?: RunOutcome[]; importError?: string };
        try {
          msg = JSON.parse(line.slice(nonce.length));
        } catch {
          return finish({ ok: false, reason: "protocol", detail: "an unreadable protocol line" });
        }
        if (msg.t === "verify" && typeof msg.id === "number") {
          let reply: Record<string, unknown>;
          try {
            reply = { id: msg.id, status: (await job.broker({ run: msg.run ?? -1, delivery: msg.delivery ?? -1, event: msg.event })) ?? null };
          } catch (e) {
            reply = { id: msg.id, error: e instanceof Error ? e.message.slice(0, 120) : "verify failed" };
          }
          if (!done && child.stdin.writable) child.stdin.write(`${JSON.stringify(reply)}\n`);
        } else if (msg.t === "result") {
          if (msg.importError) finish({ ok: false, reason: "import_failed", detail: msg.importError });
          else finish({ ok: true, runs: msg.runs ?? [] });
        }
      };

      child.stdout.on("data", (d: Buffer) => {
        bytes += d.length;
        if (bytes > MAX_STDOUT_BYTES) return finish({ ok: false, reason: "output_too_large", detail: `${bytes} bytes` });
        buffer += d.toString();
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          void handleLine(line);
        }
      });
      child.on("exit", (code, signal) => {
        // give a final result line a moment to be processed
        setTimeout(() => finish({ ok: false, reason: "crashed", detail: `exit ${code ?? signal}: ${stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}` }), 50);
      });
      child.on("error", (e) => finish({ ok: false, reason: "crashed", detail: e.message.slice(0, 200) }));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
