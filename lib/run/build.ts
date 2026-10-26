// The live snapshot (S5): one call that gives the screen everything it renders for a judge-lane session, in the shape every screen renders
// (snapshot.ts). The scan, the certificate and the heartbeat are computed from the same ScanResult, so they cannot disagree; the causes
// come from the recorded model answers (never a live model call: there is no gate here, so diagnose() would refuse one) and the replay
// is the real one while the stored deliveries are young enough, the recorded result after that, and nothing when there is neither.
//
// A cause is never paired with another mode's replay: both are looked up by the session's own planted mode, and confirmationOf() checks
// once more that the category fits the mode the replay was run for.
import { symptomClassOf, type SymptomClass } from "../cause/categories.ts";
import { diagnose, type CauseResult } from "../cause/cause.ts";
import { confirmationOf } from "../cause/confirm.ts";
import { caseAgeMs, REPLAY_WINDOW_MS, replayOrRecorded, type RecordedReplays, type ReplayResult, type VerifyFn } from "../cause/replay.ts";
import { loadReplayCase } from "../cause/replay-source.ts";
import { certificateOf, rowsInsideListLag } from "../cert/cert.ts";
import { recordedFix, type FixStore } from "../fix/recorded.ts";
import type { FixResult } from "../fix/types.ts";
import { scanSessionWithView, type ScanDeps, type ScanResult } from "../gaps/scan.ts";
import type { DiffBundle } from "../shop/diffs.ts";
import { isBroken, isPlanted, type Mode, type PlantedMode } from "../shop/types.ts";
import { errorFields } from "../web/http.ts";
import { heartbeatOfScan } from "../witness/heartbeat.ts";
import type { AttemptEntry, WitnessStore } from "../witness/store.ts";
import { deployInput } from "./deploy-input.ts";
import { CAUSE_RECORDINGS_DIR } from "./recordings.ts";
import type { GapCause, RunSnapshot } from "./snapshot.ts";

// Where a live replay gets its signed deliveries and how it verifies them. Built on demand: a snapshot with no gap never needs any of it.
export interface ReplayDeps {
  witness: () => Pick<WitnessStore, "attempts">;
  webhookIdOf: (entry: AttemptEntry) => string | undefined;
  verify: VerifyFn;
  cache?: Map<string, ReplayResult>; // a replay is done once per session, mode and pair of deliveries, not once per poll
  inflight?: Map<string, Promise<ReplayResult | null>>; // a replay that is running: a second poll waits for it instead of starting its own
}

// "Prove the fix". A snapshot carries the RECORDED fix result (lib/fix/recorded.ts): the model's edits were recorded and the controls were run
// on the owner's machine, so a deployed function reads JSON and nothing else: no model call, no sandbox, no child process, no model-written code.
export interface FixDeps {
  store?: FixStore; // tests: other recorded results than fixtures/fix/
  /**
   * Record time only (scripts/record-run.ts): runs the reviewed patch again on this session's own deliveries, in the sandbox child process, and
   * gives the controls it found (basis "replayed"). Null or a throw: the recorded result is shown instead.
   */
  prove?: (arg: { mode: PlantedMode; recorded: FixResult; scan: ScanResult }) => Promise<FixResult | null>;
}

export interface SnapshotDeps {
  scan: ScanDeps;
  bundle: DiffBundle; // the build-time diffs the cause step reads
  recordedReplays: RecordedReplays; // the recorded results for deliveries past the replay window, or when a live replay is not allowed
  replay?: ReplayDeps; // absent: no live replay, the recorded result is shown
  fix?: FixDeps; // absent: the recorded fix results of fixtures/fix/
  causeDir?: string; // a recordings directory other than the default (tests)
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

export interface SnapshotOptions {
  /** Asked right before a live replay (2 x N verify calls) is made; false means the recorded result is shown instead. */
  allowReplay?: () => Promise<boolean>;
}

const CACHE_MAX = 200;
const CAUSED_BY_HANDLER = new Set(["ACKED_BUT_NOT_APPLIED", "HANDLER_REJECTING"]);

// The order the deliveries really reach the shop in, per planted mode (A25): a late payment after the refund is what last_write_wins gets wrong.
const arrivalOrder = (mode: PlantedMode): ("completed" | "refunded")[] => (mode === "last_write_wins" ? ["refunded", "completed"] : ["completed", "refunded"]);

export async function buildLiveSnapshot(deps: SnapshotDeps, sid: string, session: { mode: Mode; at: number }, opts: SnapshotOptions = {}): Promise<RunSnapshot> {
  // The snapshot asks for PayPal's event list on every call (listing: true): the heartbeat compares the witness with it.
  const { scan, view } = await scanSessionWithView(deps.scan, sid, session, { listing: true });
  return {
    mode: "LIVE",
    recordedAt: null,
    step: null,
    session: view,
    scan,
    causes: await causesOf(deps, sid, scan, opts),
    certificate: certificateOf(scan, { rowsInsideListLag: rowsInsideListLag(view.orders, scan.at) }),
    heartbeat: heartbeatOfScan(scan, view),
  };
}

// One entry for each gap row that a handler bug can explain (a delivery was answered 2xx and not applied, or rejected). A session whose
// handler is the good one has none: no diff exists for it, and the cause of a gap that an earlier planted mode made is not guessed.
// A replay is made only for a proposed cause of a code bug: a cause that is not proposed has nothing to replay, and the setting bug has no
// code to replay (its diff holds no code line, so its cause can only be "not proven").
export async function causesOf(deps: SnapshotDeps, sid: string, scan: ScanResult, opts: SnapshotOptions = {}): Promise<GapCause[]> {
  const mode = scan.session.mode;
  if (!isBroken(mode)) return [];
  const log = deps.log ?? (() => undefined);
  const causes = new Map<SymptomClass, CauseResult>();
  let replay: ReplayResult | null | undefined; // worked out once, for the first gap row that can be replayed; the other rows of this mode show the same result
  const fixes = new Map<string, FixResult | null>(); // one fix per mode and cause, shared by the rows of that mode
  const out: GapCause[] = [];

  for (const row of scan.rows) {
    if (row.status !== "GAP") continue;
    const ev = row.events.find((e) => e.finding && CAUSED_BY_HANDLER.has(e.finding.cls));
    if (!ev) continue;
    const symptom = symptomClassOf(ev.s);
    let cause = causes.get(symptom);
    if (!cause) {
      try {
        cause = await diagnose(deployInput(mode, deps.bundle, symptom), { mode: "replay", onMiss: "none", dir: deps.causeDir ?? CAUSE_RECORDINGS_DIR, log: () => undefined });
      } catch (e) {
        log({ outcome: "cause_unavailable", mode, symptom, ...errorFields(e) }); // the input could not be built: no cause for this row, the gap stays
        continue;
      }
      causes.set(symptom, cause);
    }
    const replayable = cause.status === "proposed" && isPlanted(mode);
    if (replayable && replay === undefined) replay = await replayOf(deps, sid, mode, scan, opts, log);
    const shown = replayable ? (replay ?? null) : null;
    const confirmation = cause.status === "proposed" ? confirmationOf(cause, shown ?? undefined) : null;
    // A fix only next to a cause that is proposed AND confirmed by the replay.
    let fix: FixResult | null = null;
    if (cause.status === "proposed" && confirmation?.confirmed && isPlanted(mode)) {
      const key = `${mode}|${cause.requestHash}`;
      if (!fixes.has(key)) fixes.set(key, await fixOf(deps, mode, cause.requestHash, scan, log));
      fix = fixes.get(key) ?? null;
    }
    out.push({ captureId: row.captureId, mode, cause, replay: shown, confirmation, ...(fix ? { fix } : {}) });
  }
  return out;
}

// The recorded fix for this cause, or (record time) the same reviewed patch proven again on this session's deliveries. Never a model call.
async function fixOf(deps: SnapshotDeps, mode: PlantedMode, causeRequestHash: string, scan: ScanResult, log: (line: Record<string, unknown>) => void): Promise<FixResult | null> {
  const recorded = recordedFix(mode, causeRequestHash, deps.fix?.store);
  if (!recorded || !deps.fix?.prove) return recorded;
  try {
    return (await deps.fix.prove({ mode, recorded, scan })) ?? recorded;
  } catch (e) {
    log({ outcome: "fix_unavailable", mode, ...errorFields(e) });
    return recorded;
  }
}

async function replayOf(deps: SnapshotDeps, sid: string, mode: PlantedMode, scan: ScanResult, opts: SnapshotOptions, log: (line: Record<string, unknown>) => void): Promise<ReplayResult | null> {
  const now = deps.now ?? Date.now;
  const recorded = deps.recordedReplays[mode];
  const fallback = (): ReplayResult | null => (recorded ? { ...recorded, basis: "recorded" } : null);
  if (!deps.replay) return fallback();

  // The first gap row whose payment and refund were both heard by the witness: its two signed deliveries are what gets replayed.
  const order = arrivalOrder(mode);
  let tids: string[] | undefined;
  for (const row of scan.rows) {
    if (row.status !== "GAP") continue;
    const found = order.map((kind) => row.events.find((e) => e.kind === kind)?.d?.tid);
    if (found.every((t): t is string => typeof t === "string")) {
      tids = found;
      break;
    }
  }
  if (!tids) return fallback(); // the witness did not hear both events: there is nothing real to replay

  const cache = deps.replay.cache;
  const key = `${sid}|${mode}|${tids.join(",")}`;
  const cached = cache?.get(key);
  if (cached) return cached;

  // A replay that is already running is waited for, not started again: the cache only fills when a replay is over, and a second poll that
  // arrives meanwhile would make the 4 verify calls again and spend the session's 3 replays an hour.
  const running = deps.replay.inflight?.get(key);
  if (running) return running;

  const work = (async (): Promise<ReplayResult | null> => {
    try {
      const c = await loadReplayCase(deps.replay!.witness(), { mode, tids: tids! }, deps.replay!.webhookIdOf);
      if (caseAgeMs(c, now()) <= REPLAY_WINDOW_MS && opts.allowReplay && !(await opts.allowReplay())) return fallback(); // the replay limit says no: the recorded one
      const result = await replayOrRecorded(c, deps.replay!.verify, deps.recordedReplays, now);
      if (cache && !(result.verdict === "NOT CONFIRMED" && result.reason === "verify_unavailable")) {
        cache.set(key, result);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
      }
      return result;
    } catch (e) {
      log({ outcome: "replay_unavailable", mode, ...errorFields(e) });
      return fallback();
    }
  })();
  deps.replay.inflight?.set(key, work);
  try {
    return await work;
  } finally {
    deps.replay.inflight?.delete(key);
  }
}
