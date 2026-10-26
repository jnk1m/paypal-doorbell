"use client";
// The live judge lane (plan 5.6, 10.1 #6, R13), in the same layout as the recorded story: the left column is the judge's five steps (enter the
// token, place an order, turn on a bug, refund it, run Doorbell) and the sticky panel on the right is the same path panel, filled from the real
// POST /api/shop/snapshot result as it arrives. Ring again works live: it asks PayPal for a resend through POST /api/shop/ring, and the panel shows
// what the heal records say, never a script.
//
// The token is kept in this tab's sessionStorage and sent only to this site. If the snapshot route is missing, or the live pool is closed, the
// lane says so and plays the recorded run instead, which needs no network.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { healArrived } from "../../lib/gaps/closure.ts";
import type { RunSnapshot } from "../../lib/run/snapshot.ts";
import { CATALOG, type ItemId } from "../../lib/shop/catalog.ts";
import { MODE_FILE } from "../../lib/shop/mode-files.ts";
import { ALL_MODES, isBroken, type Mode } from "../../lib/shop/types.ts";
import { LIVE_PENDING, LIVE_TAKES, LIVE_LEAD, LIVE_STEPS, PAUSED_NOTICE, PLANTED, TOKEN_REJECTED, UNAVAILABLE_NOTICE } from "../../lib/ui/copy.ts";
import { TermPlanner } from "../../lib/ui/glossary.ts";
import { emptyLive, failureNote, failureOf, isRunSnapshot, paceOf, snapshotKey, liveChapter, livePanel, liveRing, liveHeaders, liveSteps, networkFailure, noteText, NOT_RUNG, pollDelayMs, remember, rememberFixed, ringReadiness, ringRefusal, SESSION_KEY, TOKEN_KEY, type LaneNote, type LiveFailure, type LiveSeed, type Pace, type Pending, type PendingAction } from "../../lib/ui/live.ts";
import { liveDisputeRow, openDisputesOf } from "../../lib/ui/dispute-story.ts";
import { WAITING_PHRASE, evidenceWords, healWords } from "../../lib/ui/phrases.ts";
import { planRich, type Rich } from "../../lib/ui/rich.ts";
import { certView, liveFixProof, modeLine, unprovenWords, type ChapterNo, type Story } from "../../lib/ui/story.ts";
import { FixProofBlock } from "./fix-proof.tsx";
import { PathPanel } from "./path-panel.tsx";
import { Tick } from "./marks.tsx";
import { RichText } from "./rich-text.tsx";
import { SiteFooter } from "./site-footer.tsx";
import { StoryView } from "./story-view.tsx";
import { TopBar } from "./top-bar.tsx";
import { useLayout } from "./use-env.ts";

const store = {
  get: (k: string): string => {
    try {
      return sessionStorage.getItem(k) ?? "";
    } catch {
      return "";
    }
  },
  set: (k: string, v: string): void => {
    try {
      if (v) sessionStorage.setItem(k, v);
      else sessionStorage.removeItem(k);
    } catch {
      // a private window: the lane works, it only forgets on reload
    }
  },
};

type Phase = "probing" | "unavailable" | "paused" | "open";
interface Reply {
  ok: boolean;
  status: number;
  data: unknown;
  failure?: LiveFailure;
}

const MODE_LABEL: Record<Mode, string> = { good: "Working handler, the fix", ack_then_drop: "Dropped after a 200 OK", bad_body: "Rejected with 401", last_write_wins: "A late payment wins", wrong_webhook_id_setting: "Rejected after a settings change" };
// The bugs first, the working handler (the fix) last.
const MODE_ORDER: Mode[] = [...ALL_MODES.filter((m) => m !== "good"), "good"];
const money = (v: string) => `${v}`;

// `seed`: a state given from outside (the tests, /dev/live). The lane then starts from it, probes nothing, polls nothing and sends nothing.
export function LiveLane({ stories, layout: forced, seed }: { stories: Story[]; layout?: "both" | "wide" | "narrow"; seed?: LiveSeed }) {
  const inert = seed !== undefined;
  const [phase, setPhase] = useState<Phase>(inert ? "open" : "probing");
  const [token, setToken] = useState(inert ? "seed" : "");
  const [sid, setSid] = useState(seed ? (seed.sid ?? "seed-session") : "");
  const [snap, setSnap] = useState<RunSnapshot | null>(seed?.snap ?? null);
  const [diag, setDiag] = useState<RunSnapshot | null>(seed?.diag ?? null);
  const [fixed, setFixed] = useState<RunSnapshot | null>(seed?.fixed ?? null);
  const [everPlanted, setEverPlanted] = useState(seed?.everPlanted ?? false);
  const [failure, setFailure] = useState<LiveFailure | null>(null);
  // The request in flight (one at a time): the control that was pressed says what it waits for, and the other action buttons are off.
  const [pending, setPending] = useState<PendingAction | null>(seed?.pending ?? null);
  // What the judge is told beside the control they pressed, and that stays until the next press: a request that failed, or a ring the server refused.
  const [note, setNote] = useState<LaneNote | null>(seed?.note ?? null);
  const busy = pending !== null;
  const [actedAt, setActedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(0);
  const [choice, setChoice] = useState<{ ch: ChapterNo; auto: ChapterNo } | null>(null);
  const layout = useLayout(forced);

  const polling = useRef(false);
  const unchanged = useRef(0);
  const lastKey = useRef("");
  const pace = useRef<Pace>("idle");
  const again = useRef<() => void>(() => undefined); // starts the wait for the next poll afresh, from the newest snapshot's pace; set by the polling effect
  const diagRef = useRef<RunSnapshot | null>(null);
  const fixedRef = useRef<RunSnapshot | null>(null);

  // The lane's first question: is it deployed at all? One unauthenticated request; it carries no token and changes nothing.
  useEffect(() => {
    if (inert) return;
    const t = store.get(TOKEN_KEY);
    const s = store.get(SESSION_KEY);
    setToken(t);
    setSid(s);
    if (t && s) {
      setPhase("open");
      return;
    }
    let gone = false;
    fetch("/api/shop/snapshot", { method: "POST", cache: "no-store" })
      .then((res) => {
        void res.body?.cancel(); // only the status matters; an unread body would keep the request open
        if (gone) return;
        setPhase(res.status === 429 || res.status === 503 ? "paused" : res.status === 404 || res.status === 405 || res.status >= 500 ? "unavailable" : "open");
      })
      .catch(() => !gone && setPhase("unavailable"));
    return () => {
      gone = true;
    };
  }, [inert]);

  const request = useCallback(
    async (path: string, body?: unknown, session = sid): Promise<Reply> => {
      if (inert) return { ok: false, status: 0, data: null, failure: networkFailure() };
      try {
        const res = await fetch(path, { method: "POST", cache: "no-store", headers: liveHeaders(token, session, body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined });
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        if (res.ok) return { ok: true, status: res.status, data };
        return { ok: false, status: res.status, data, failure: failureOf(res.status, data?.error?.message) };
      } catch {
        return { ok: false, status: 0, data: null, failure: networkFailure() };
      }
    },
    [token, sid, inert],
  );

  // `what`: the action that failed. Its message is told in place, beside its control; a failure of the background poll has no action and is told in the last step.
  const onFailure = useCallback((f: LiveFailure, what?: Pending) => {
    if (f.kind === "unavailable") setPhase("unavailable");
    else if (f.kind === "paused") setPhase("paused");
    else if (f.kind === "token") {
      store.set(TOKEN_KEY, "");
      store.set(SESSION_KEY, "");
      setToken("");
      setSid("");
      setSnap(null);
      setDiag(null);
      diagRef.current = null;
      fixedRef.current = null;
      setFixed(null);
      setFailure({ ...f, message: TOKEN_REJECTED });
    } else if (f.kind === "session") {
      store.set(SESSION_KEY, "");
      setSid("");
      setSnap(null);
      setDiag(null);
      diagRef.current = null;
      fixedRef.current = null;
      setFixed(null);
      setFailure({ ...f, message: "This session has ended. Start a new one." });
    } else if (what) setNote(failureNote(what, f));
    else setFailure(f);
  }, []);

  const poll = useCallback(async () => {
    if (!token || !sid || polling.current) return;
    polling.current = true;
    try {
      const r = await request("/api/shop/snapshot");
      if (!r.ok) {
        if (r.status === 429) {
          unchanged.current += 1; // a refused poll backs off like a quiet one
          return;
        }
        return onFailure(r.failure!);
      }
      if (!isRunSnapshot(r.data)) return setFailure({ kind: "error", message: "The live service answered, but not with a snapshot." });
      const key = snapshotKey(r.data);
      unchanged.current = key === lastKey.current ? unchanged.current + 1 : 0;
      lastKey.current = key;
      pace.current = paceOf(r.data);
      diagRef.current = remember(diagRef.current, r.data);
      fixedRef.current = rememberFixed(fixedRef.current, diagRef.current, r.data);
      setDiag(diagRef.current);
      setFixed(fixedRef.current);
      if (r.data.session.session.planted) setEverPlanted(true);
      setSnap(r.data);
      setFailure(null);
    } finally {
      polling.current = false;
    }
  }, [request, token, sid, onFailure]);

  // Poll at once, then at the pace of what the snapshot waits for (lib/ui/live.ts pollDelayMs: 3 s while a row moves, 5 s while PayPal's clock is awaited,
  // backing off to 5 minutes when nothing is), and not while the tab is hidden. A tab that comes back polls at once, so a quiet lane is never far behind.
  useEffect(() => {
    if (inert || phase !== "open" || !token || !sid) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(tick, ms);
    };
    const tick = async () => {
      if (stop) return;
      if (!document.hidden) await poll();
      if (!stop) schedule(pollDelayMs(unchanged.current, pace.current));
    };
    const shown = () => {
      if (stop || document.hidden) return;
      unchanged.current = 0;
      schedule(0);
    };
    document.addEventListener("visibilitychange", shown);
    again.current = () => !stop && schedule(pollDelayMs(unchanged.current, pace.current));
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
      again.current = () => undefined;
      document.removeEventListener("visibilitychange", shown);
    };
  }, [inert, phase, token, sid, poll]);

  // A real clock for the wait, so that nothing is sped up or faked: seconds since the last action.
  useEffect(() => {
    if (actedAt === null) return;
    setClock(Date.now());
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, [actedAt]);

  // One press: the control says what it waits for (`what`), the other action buttons are off, and a failure is told beside the control, not at the end of the page.
  const act = useCallback(
    async (what: PendingAction, path: string, body?: unknown) => {
      setNote(null);
      setPending(what);
      try {
        const r = await request(path, body);
        if (!r.ok) onFailure(r.failure!, what.kind);
        else {
          setActedAt(Date.now());
          unchanged.current = 0;
          await poll();
          again.current(); // the wait that was running may be minutes long (a quiet lane): an action starts the ladder again
        }
      } finally {
        setPending(null);
      }
    },
    [request, poll, onFailure],
  );

  const run = async () => {
    setNote(null);
    setPending({ kind: "run" });
    try {
      await poll();
      again.current();
    } finally {
      setPending(null);
    }
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setNote(null);
    setPending({ kind: "start" });
    try {
      store.set(TOKEN_KEY, token);
      const r = await request("/api/shop/session", undefined, "");
      if (!r.ok) return onFailure(r.failure!, "start");
      const id = (r.data as { session?: string } | null)?.session;
      if (!id) return setFailure({ kind: "error", message: "The live service did not return a session." });
      store.set(SESSION_KEY, id);
      setSid(id);
      setSnap(null);
      setDiag(null);
      diagRef.current = null;
      fixedRef.current = null;
      setFixed(null);
      setEverPlanted(false);
      setFailure(null);
      unchanged.current = 0;
    } finally {
      setPending(null);
    }
  };

  const view = snap ?? emptyLive(sid);
  const steps = liveSteps(view, { hasSession: !!sid, everPlanted });
  const { panel } = useMemo(() => livePanel(view, diag, fixed), [view, diag, fixed]);
  const ring = useMemo(() => liveRing(view, panel.subject?.n ?? null), [view, panel.subject]);
  const auto = liveChapter(panel, view);
  const chapter = choice && choice.auto === auto && panel.available[choice.ch] ? choice.ch : auto;
  const elapsed = actedAt !== null && clock > 0 ? Math.max(0, Math.round((clock - actedAt) / 1000)) : null;
  const latest = [...view.session.orders].reverse().find((o) => o.paypal === "COMPLETED");

  // The gaps Doorbell found, each with where Ring again stands for it.
  const gaps = (view.scan?.rows ?? []).flatMap((row) => row.events.filter((e) => (e.finding && row.status !== "TIED") || (e.heal && (row.status !== "TIED" || healArrived(e.heal)))).map((ev) => ({ row, ev })));
  // The open disputes Doorbell found: a gap with no event to send again, told with the recorded dispute story's sentences (lib/ui/dispute-story.ts).
  const disputes = openDisputesOf(view);
  // Ring again is on only when the newest snapshot says a row can be rung (its event is in PayPal's list and nothing holds it back) and no request is in flight.
  const readiness = useMemo(() => ringReadiness(view), [view]);
  const ringOn = !busy && readiness.ready.length > 0;

  const ringAll = async () => {
    setNote(null);
    setPending({ kind: "ring" });
    try {
      const refused: string[] = [];
      let sent = 0;
      for (const captureId of readiness.ready) {
        const g = gaps.find((x) => x.row.captureId === captureId);
        const r = await request("/api/shop/ring", { captureId });
        if (!r.ok) {
          onFailure(r.failure!, "ring");
          return;
        }
        // The server decides again at this moment, from a fresh read of PayPal's list: this page's snapshot can be a few seconds behind it
        const why = ringRefusal(r.data, g?.ev.kind === "refunded" ? "refund" : "payment");
        if (why) refused.push(readiness.ready.length > 1 && g ? `Order #${g.row.n}: ${why}` : why);
        else sent++;
      }
      if (refused.length > 0) setNote({ step: 4, tone: "info", message: NOT_RUNG, reasons: refused });
      if (sent > 0) setActedAt(Date.now());
      unchanged.current = 0;
      await poll();
      again.current();
    } finally {
      setPending(null);
    }
  };

  // The words of the left column, planned in the order they are printed so that a glossary word is explained once, where it first appears.
  const copy = useMemo(() => {
    const p = new TermPlanner();
    const rich = (s: string): Rich => planRich(p, s);
    const bar = modeLine(p, { mode: "LIVE", recordedAt: null });
    const lead = rich(LIVE_LEAD);
    const lines = LIVE_STEPS.map((s) => rich(s.line));
    // A sentence that explains a state (a fixed one) is printed once, under the first row in that state.
    const said = new Set<string>();
    const once = (text: string | null): Rich | null => {
      if (!text || said.has(text)) return null;
      said.add(text);
      return rich(text);
    };
    const unprovenOnce = (captureId: string): Rich | null => {
      const u = unprovenWords((diag ?? view).causes.find((c) => c.captureId === captureId) ?? null);
      return u ? once(`${u.h} ${u.reason}`) : null;
    };
    const rows = gaps.map(({ row, ev }) => {
      const w = ev.heal ? healWords({ state: ev.heal.state, sends: ev.heal.sends, ...(ev.heal.arrivalSeconds !== undefined ? { arrivalSeconds: ev.heal.arrivalSeconds } : {}), ...(ev.heal.answer !== undefined ? { answer: ev.heal.answer } : {}) }, row.status === "TIED") : null;
      return {
        key: `${row.captureId}:${ev.kind}`,
        title: rich(`Order #${row.n}: ${w ? w.title : evidenceWords(ev.finding!).title}.`),
        // a tied row says its numbers in the panel's ledger; here it only says Healed. Why Ring again waits is said once, beside the button.
        detail: row.status === "TIED" ? null : once(w ? w.detail : ev.finding?.waiting ? WAITING_PHRASE[ev.finding.waiting] : null),
        // why the AI named no cause: the words of the recorded story's third chapter, from the diagnosis the lane remembers (the cause belongs to the planted handler)
        cause: row.status === "TIED" ? null : unprovenOnce(row.captureId),
      };
    });
    rows.push(
      ...disputes.map((o) => {
        const w = liveDisputeRow(view, o);
        return { key: `${o.row.captureId}:${o.d.disputeId}`, title: rich(w.title), detail: once(w.detail), cause: once(w.cause) };
      }),
    );
    const ringReason = readiness.reason ? rich(readiness.reason) : null;
    // the proposed fix is planned after the rows and before the certificate: the order they are printed in
    const proof = liveFixProof(diag, fixed, rich);
    const cv = view.certificate ? certView(view, diag ?? view, gaps.some((g) => g.ev.heal), rich) : null;
    return { bar, lead, lines, rows, ringReason, proof, cv };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, diag, fixed, sid]);

  if (phase === "unavailable" || phase === "paused") {
    return <StoryView stories={stories} notice={phase === "paused" ? PAUSED_NOTICE : UNAVAILABLE_NOTICE} layout={forced} />;
  }

  const wide = layout !== "narrow";
  const narrow = layout !== "wide";
  const green = view.certificate?.stamp === "green";
  const cls = (i: number) => `lstep ${steps[i]}`;
  const head = (i: number, n: string, title: string) => (
    <h2 id={`s${i + 1}-h`}>
      <span className="n">{n}</span>
      {title}
      {steps[i] === "done" ? (
        <span className="done-mark">
          <Tick done />
          <span className="sr"> done</span>
        </span>
      ) : null}
    </h2>
  );

  // What the judge is told in place: a request that failed (red text) or a Ring again the server did not send (plain text), kept beside the control until the next press.
  const noteEl = (i: number) =>
    note && note.step === i ? (
      note.tone === "error" ? (
        <p className="form-error" role="alert">
          {note.message}
        </p>
      ) : (
        <p className="live-status" role="status">
          {noteText(note, readiness.reason)}
        </p>
      )
    ) : null;
  const busyOf = (kind: Pending) => pending?.kind === kind;

  const panelEl = (fixedTabs: boolean) => (
    <PathPanel panel={panel} chapter={chapter} ring={ring} motion={false} tabs={fixedTabs} onGo={(ch) => setChoice({ ch, auto })} />
  );

  return (
    <>
      <TopBar bar={copy.bar} link={{ href: "/", label: "Recorded run" }} />

      <main id="main" className="stage" data-cert={green ? "green" : "none"}>
        <div className="narr steps-col">
          <section className="lead-block" aria-labelledby="live-h">
            <div className="copy">
              <h1 className="focal xl" id="live-h">
                Plant a bug, then watch Doorbell find it.
              </h1>
              <p className="lead">
                <RichText r={copy.lead} />
              </p>
              {phase === "probing" ? <p className="live-status" role="status">Checking whether the live lane is running.</p> : null}
              <noscript>
                <p className="small">The live lane needs JavaScript. The recorded run does not.</p>
              </noscript>
            </div>
          </section>

          <div className="copy">
            <section className={cls(0)} aria-labelledby="s1-h" aria-current={steps[0] === "current" ? "step" : undefined}>
              {head(0, "1", LIVE_STEPS[0].title)}
              <p className="body">
                <RichText r={copy.lines[0]} />
              </p>
              {sid ? (
                <p className="live-status">
                  Session <span className="mono">{sid.slice(0, 8)}</span> is open.
                </p>
              ) : phase === "open" ? (
                <form onSubmit={start}>
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="token">Judge token</label>
                      <input id="token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
                    </div>
                    <button type="submit" className="btn" disabled={busy || !token} aria-busy={busyOf("start") || undefined}>
                      {busyOf("start") ? LIVE_PENDING.start : "Start a session"}
                    </button>
                  </div>
                </form>
              ) : null}
              {failure && !sid ? (
                <p className="form-error" role="alert">
                  {failure.message}
                </p>
              ) : null}
              {noteEl(0)}
            </section>

            <section className={cls(1)} aria-labelledby="s2-h" aria-current={steps[1] === "current" ? "step" : undefined}>
              {head(1, "2", LIVE_STEPS[1].title)}
              <p className="body">
                <RichText r={copy.lines[1]} />
              </p>
              <div className="choices">
                {(Object.keys(CATALOG) as ItemId[]).map((id) => (
                  <button key={id} type="button" className="btn-quiet" disabled={busy || !sid} aria-busy={(busyOf("order") && pending?.target === id) || undefined} onClick={() => void act({ kind: "order", target: id }, "/api/shop/order", { item: id })}>
                    {busyOf("order") && pending?.target === id ? LIVE_PENDING.order : `${CATALOG[id].name} ${money(CATALOG[id].price)}`}
                  </button>
                ))}
              </div>
              {noteEl(1)}
            </section>

            <section className={cls(2)} aria-labelledby="s3-h" aria-current={steps[2] === "current" ? "step" : undefined}>
              {head(2, "3", LIVE_STEPS[2].title)}
              <p className="body">
                <RichText r={copy.lines[2]} />
              </p>
              <fieldset className="modes">
                <legend className="sr">Handler of the shop</legend>
                {MODE_ORDER.map((m) => (
                    <label key={m} className="mode-opt">
                      <input type="radio" name="mode" checked={busyOf("mode") ? m === pending?.target : m === view.session.session.mode} disabled={busy || !sid} onChange={() => void act({ kind: "mode", target: m }, "/api/shop/mode", { mode: m })} />
                      <span>
                        {MODE_LABEL[m]}
                        {isBroken(m) ? `, ${PLANTED}` : ""}
                        <span className="small">
                          <span className="mono">{MODE_FILE[m]}</span>
                        </span>
                      </span>
                    </label>
                ))}
              </fieldset>
              {busyOf("mode") ? (
                <p className="live-status" role="status">
                  {LIVE_PENDING.mode}
                </p>
              ) : null}
              {noteEl(2)}
            </section>

            <section className={cls(3)} aria-labelledby="s4-h" aria-current={steps[3] === "current" ? "step" : undefined}>
              {head(3, "4", LIVE_STEPS[3].title)}
              <p className="body">
                <RichText r={copy.lines[3]} />
              </p>
              <button type="button" className={steps[3] === "current" ? "btn" : "btn-quiet"} disabled={busy || !latest} aria-busy={busyOf("refund") || undefined} onClick={() => latest && void act({ kind: "refund" }, "/api/shop/refund", { captureId: latest.captureId })}>
                {busyOf("refund") ? LIVE_PENDING.refund : latest ? `Refund order #${latest.n}` : "Place an order first"}
              </button>
              {noteEl(3)}
            </section>

            <section className={cls(4)} aria-labelledby="s5-h" aria-current={steps[4] === "current" ? "step" : undefined}>
              {head(4, "5", LIVE_STEPS[4].title)}
              <p className="body">
                <RichText r={copy.lines[4]} />
              </p>
              {narrow ? <div className="vis-inline">{panelEl(true)}</div> : null}
              <button type="button" className={steps[4] === "current" ? "btn" : "btn-quiet"} disabled={busy || !sid} aria-busy={busyOf("run") || undefined} onClick={() => void run()}>
                {busyOf("run") ? LIVE_PENDING.run : "Run Doorbell"}
              </button>
              <p className="live-status" role="status">
                {pending ? `${LIVE_PENDING[pending.kind]} ` : ""}
                {elapsed !== null ? `${elapsed} s since your last action. A run takes ${LIVE_TAKES}.` : "Nothing has been done in this session yet."}
              </p>
              {failure && sid && failure.kind !== "token" ? (
                <p className="form-error" role="alert">
                  The live service had a problem: {failure.message}. Nothing on this page was changed.
                </p>
              ) : null}

              {copy.rows.length > 0 ? (
                <div className="gap-rows">
                  {copy.rows.map((r) => (
                    <div className="gap-row" key={r.key}>
                      <p>
                        <RichText r={r.title} />
                      </p>
                      {r.detail ? (
                        <p className="small">
                          <RichText r={r.detail} />
                        </p>
                      ) : null}
                      {r.cause ? (
                        <p className="small">
                          <RichText r={r.cause} />
                        </p>
                      ) : null}
                    </div>
                  ))}
                  <div className="ring-line">
                    <button type="button" className={ringOn || busyOf("ring") ? "btn" : "btn-quiet"} disabled={!ringOn} aria-busy={busyOf("ring") || undefined} aria-describedby={!busyOf("ring") && copy.ringReason ? "ring-why" : undefined} onClick={() => void ringAll()}>
                      {busyOf("ring") ? LIVE_PENDING.ring : "Ring again"}
                    </button>
                    {!busyOf("ring") && copy.ringReason ? (
                      <p className="small" id="ring-why">
                        <RichText r={copy.ringReason} />
                      </p>
                    ) : null}
                    {noteEl(4)}
                  </div>
                </div>
              ) : (
                noteEl(4)
              )}

              {copy.proof ? (
                <div className="fx-live">
                  <h3 className="fx-h">A patch for the cause the AI cited</h3>
                  <FixProofBlock proof={copy.proof} />
                </div>
              ) : null}

              {copy.cv ? (
                <div className="cert-live">
                  <p className="lead">
                    {copy.cv.focal} {copy.cv.lead}
                  </p>
                  <h3>First, what Doorbell cannot prove</h3>
                  <ul className="list dash">
                    {copy.cv.cannot.map((r, i) => (
                      <li key={i}>
                        <RichText r={r} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          </div>
        </div>
        {wide ? (
          <aside className="aside" aria-label={panel.subject ? `The delivery path for ${panel.subject.label.toLowerCase()}` : "The delivery path"}>
            {panelEl(false)}
          </aside>
        ) : null}
      </main>
      <SiteFooter live={false} />
    </>
  );
}

