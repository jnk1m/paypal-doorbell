"use client";
// The path panel (S5 design): PayPal, Doorbell, your shop, your books, on a road that fills in as the message passes. ONE sticky panel follows
// the chapter on a wide screen; under 1100 px each chapter carries its own copy of it (fixed to that chapter). What it draws is a Panel
// (lib/ui/story.ts): layers that a chapter turns on, so the same four stations are redrawn for each chapter instead of being replaced.
//
// Motion, all of it meaning something and none of it ambient:
//   the message travels once when the chapter "How it travelled" comes in (a dot and the road filling);
//   the replay's two builds fork;
//   Ring again: a ripple at Doorbell, the message going out and arriving (a small dot on the road; the row below counts the seconds),
//   the books sliding to the new line.
// With reduced motion every one of them shows its end state at once. The panel never makes a request.
import { useEffect, useRef, useState } from "react";
import { SHOP_NAME } from "../../lib/ui/copy.ts";
import type { RingView } from "../../lib/ui/ring.ts";
import { CHAPTERS, markOf, tokensOf, type ChapterNo, type Layer, type LedgerRow, type Panel, type Phase, type ReplayModel, type Station } from "../../lib/ui/story.ts";
import { Mark, Tick } from "./marks.tsx";
import { RichText } from "./rich-text.tsx";

export interface PathPanelProps {
  panel: Panel;
  chapter: ChapterNo; // the chapter whose layers are on
  fixed?: boolean; // an inline panel: this one chapter, no tabs
  tabs?: boolean; // keep the chapter tabs when the panel sits inline (the live lane)
  ring: RingView;
  motion: boolean; // false under reduced motion
  onGo?: (ch: ChapterNo) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The line on the stretch of road that the first chapter has not traced.
const BETWEEN = "What happened in between: the next chapter traces it";
// The replay chapter when there is no replay (the cause is not proven, or not diagnosed): without it the panel would be a blank, which reads as loading.
export const NO_REPLAY = "No replay result to show for this gap.";

interface Fx {
  busy: boolean; // the road is being animated: use these values instead of the resting ones
  lit: boolean[];
  fd: string[];
  fdl: string[];
  dot: { on: boolean; y: number; ms: number } | null;
}
const REST: Fx = { busy: false, lit: [], fd: [], fdl: [], dot: null };
const EMPTY = [false, false, false];
const ZERO = ["0s", "0s", "0s"];

// How far the road is filled at rest: nothing in the first chapter, up to the shop in the chapters that follow the message there, and on to
// the books once the ring is done and the books changed.
function litAtRest(ch: ChapterNo, ring: RingView, reach: number): boolean[] {
  const n = ch === 1 || ch === 4 || ch === 7 ? 0 : ch === 6 && ring.stage === "done" && ring.phase === "saved" ? 3 : reach;
  return [0, 1, 2].map((i) => i < n);
}

export function PathPanel({ panel, chapter, fixed = false, tabs = false, ring, motion, onGo }: PathPanelProps) {
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const run = useRef(0);
  const [fx, setFx] = useState<Fx>(REST);
  const [seen, setSeen] = useState(!fixed);
  const [replayOn, setReplayOn] = useState(false);
  const [travelled, setTravelled] = useState(false);

  const tokens = tokensOf(chapter, ring.phase);
  const on = (l: string[]): boolean => l.some((t) => tokens.includes(t));

  // An inline panel plays its motion when it comes into view; the sticky one plays it when its chapter comes in.
  useEffect(() => {
    if (!fixed || !root.current || seen) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.55 },
    );
    io.observe(root.current);
    return () => io.disconnect();
  }, [fixed, seen]);

  useEffect(() => {
    if (chapter === 4 && seen) setReplayOn(true);
  }, [chapter, seen]);

  const stationY = (i: number): number => {
    const li = list.current?.children[i] as HTMLElement | undefined;
    return li ? li.offsetTop : 0;
  };
  const visible = (): boolean => !!root.current && root.current.offsetParent !== null;

  // Chapter 2: the message travels from PayPal to Doorbell to the shop, once.
  useEffect(() => {
    if (chapter !== 2) {
      setTravelled(chapter > 2);
      return;
    }
    if (!seen || !panel.available[2]) return;
    if (panel.reach === 0) {
      // [Track UI-B] nothing was sent, so nothing travels: the road stays as it is
      setTravelled(true);
      return;
    }
    const id = ++run.current;
    const ok = (): boolean => run.current === id;
    void (async () => {
      if (!motion || !visible()) {
        setTravelled(true);
        return;
      }
      setFx({ busy: true, lit: EMPTY, fd: ZERO, fdl: ZERO, dot: null });
      await sleep(650);
      if (!ok()) return;
      setFx((f) => ({ ...f, dot: { on: true, y: stationY(0), ms: 0 } }));
      await sleep(40);
      for (let i = 0; i < 2; i++) {
        if (!ok()) return;
        setFx((f) => ({ ...f, lit: f.lit.map((l, j) => l || j === i), fd: f.fd.map((d, j) => (j === i ? "900ms" : d)), dot: { on: true, y: stationY(i + 1), ms: 900 } }));
        await sleep(900);
      }
      if (!ok()) return;
      setFx(REST);
      setTravelled(true);
    })();
    return () => {
      run.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter, seen, motion, panel]);

  // Chapter 6: Ring again. Each phase of the script (lib/ui/ring.ts) moves the message one step; the ticks of the elapsed-seconds token do not.
  useEffect(() => {
    if (chapter !== 6) return;
    if (ring.stage === "idle") {
      setFx(REST);
      return;
    }
    if (!motion || !visible()) return;
    const id = ++run.current;
    const ok = (): boolean => run.current === id;
    void (async () => {
      const a = stationY(0);
      const b = stationY(1);
      const c = stationY(2);
      if (ring.phase === "ask") {
        setFx({ busy: true, lit: EMPTY, fd: ZERO, fdl: ZERO, dot: { on: true, y: b, ms: 0 } });
        await sleep(40);
        if (!ok()) return;
        setFx((f) => ({ ...f, dot: { on: true, y: a, ms: 400 } }));
      } else if (ring.phase === "sent") {
        const total = Math.max(ring.travel.ms, 300);
        const d0 = (total * (b - a)) / Math.max(1, c - a);
        setFx({ busy: true, lit: EMPTY, fd: ZERO, fdl: ZERO, dot: { on: true, y: a, ms: 0 } });
        await sleep(40);
        if (!ok()) return;
        if (ring.travel.to === "half") {
          setFx({ busy: true, lit: [true, false, false], fd: [`${total}ms`, "0s", "0s"], fdl: ZERO, dot: { on: true, y: (a + b) / 2, ms: total } });
          await sleep(total);
          if (!ok()) return;
          setFx((f) => ({ ...f, dot: { on: false, y: (a + b) / 2, ms: 0 } }));
        } else {
          setFx({ busy: true, lit: [true, true, false], fd: [`${d0}ms`, `${total - d0}ms`, "0s"], fdl: ["0s", `${d0}ms`, "0s"], dot: { on: true, y: c, ms: total } });
        }
      } else if (ring.phase === "arrived") {
        setFx((f) => ({ busy: true, lit: [true, true, true], fd: [f.fd[0] ?? "0s", f.fd[1] ?? "0s", "350ms"], fdl: ZERO, dot: { on: true, y: stationY(3), ms: 350 } }));
        await sleep(380);
        if (!ok()) return;
        setFx((f) => ({ ...f, dot: { on: false, y: stationY(3), ms: 0 } }));
      } else if (ring.phase === "saved" || ring.phase === "lost") {
        setFx((f) => ({ ...f, busy: ring.stage === "running", lit: ring.phase === "saved" ? [true, true, true] : [true, true, false], dot: null }));
      }
    })();
    return () => {
      run.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter, ring.phase, ring.asks, ring.stage, motion]);

  // Leaving the two motion chapters, the road goes back to its resting length.
  useEffect(() => {
    if (chapter !== 2 && chapter !== 6) setFx(REST);
  }, [chapter]);

  const awaitingTravel = chapter === 2 && !travelled && motion && panel.available[2];
  const lit = fx.busy && (chapter === 2 || chapter === 6) ? fx.lit : awaitingTravel ? EMPTY : litAtRest(chapter, ring, panel.reach ?? 2);
  const busy = fx.busy && (chapter === 2 || chapter === 6);

  // The sticky panel keeps all three parts mounted so that they collapse and expand; an inline panel holds only its own chapter's.
  const showPath = chapter === 1 || chapter === 2 || chapter === 3 || chapter === 5 || chapter === 6;
  const showReplay = chapter === 4;
  // The first chapter shows the ledger only in the sticky panel: inline, the word Gap would come before the text that explains it.
  const showLedger = (chapter === 1 && !fixed) || chapter === 5 || chapter === 6 || chapter === 7;
  const full = CHAPTERS.find((c) => c.no === chapter)!.full;
  // The first chapter knows the two ends (what PayPal says, what the books say) and has not traced the hops between yet: it draws one dashed
  // stretch of road with a line saying so, not a row of empty stations that looks like a page still loading. The stations in between stay in
  // the markup (the next chapters fill them) and are hidden by the stylesheet (".sts[data-untraced]").
  const ends = panel.stations.length > 2 && markOf(panel.stations[0], chapter, ring.phase) !== "ghost" && markOf(panel.stations[panel.stations.length - 1], chapter, ring.phase) !== "ghost";
  const untraced = chapter === 1 && ends && panel.stations.slice(1, -1).every((st) => markOf(st, chapter, ring.phase) === "ghost");
  const dot = busy && fx.dot ? fx.dot : null;
  const subject = panel.subject;

  return (
    <div className={`vis${tabs ? " tabs" : ""}`} ref={root} data-ch={chapter}>
      <header className="v-head">
        {fixed ? (
          <p className="cap">
            Chapter {chapter} of {CHAPTERS.length}: {full}
          </p>
        ) : (
          <nav className="steps" aria-label="Story chapters">
            {CHAPTERS.map((c) => (
              <button key={c.no} type="button" data-go={c.no} disabled={!panel.available[c.no]} aria-current={c.no === chapter ? "step" : undefined} onClick={() => onGo?.(c.no)}>
                {c.tab}
              </button>
            ))}
          </nav>
        )}
        <div className="v-subs">
          {chapter === 7 ? (
            <p className="subj is-on">
              <span>
                {SHOP_NAME}, this run: {panel.ledger.length} captures, <b>{panel.money}</b>
              </span>
            </p>
          ) : (
            <p className="subj is-on">
              {subject ? (
                <>
                  <span>
                    {subject.label}, <b>{subject.amount}</b>
                  </span>
                  <span>
                    PayPal id <span className="mono">{subject.captureId}</span>
                  </span>
                </>
              ) : (
                <span>Nothing to trace yet</span>
              )}
            </p>
          )}
        </div>
      </header>

      {!fixed || showPath ? (
        <div className={`lay w-path${showPath ? " is-on" : ""}`}>
          <div className="in">
            <div className="path">
              <ol className="sts" ref={list} data-untraced={untraced ? "" : undefined}>
                {panel.stations.flatMap((st, i) => [
                  <StationView key={st.key} st={st} chapter={chapter} fixed={fixed} tokens={tokens} on={on} phase={ring.phase} lit={lit[i] ?? false} fd={busy ? fx.fd[i] : undefined} fdl={busy ? fx.fdl[i] : undefined} ringing={st.key === "doorbell" && ring.asks > 0 && ring.stage !== "idle"} ringKey={ring.asks} />,
                  ...(untraced && i === 0
                    ? [
                        <li className="st st-between" key="between" data-k="between">
                          <p className="between">{BETWEEN}</p>
                        </li>,
                      ]
                    : []),
                ])}
              </ol>
              <div className={`dot${dot?.on ? " on" : ""}`} aria-hidden="true" style={{ "--dot-y": `${dot?.y ?? 0}px`, "--dot-ms": `${dot?.ms ?? 0}ms` } as React.CSSProperties}>
                <svg viewBox="0 0 28 28">
                  <circle className="dot-disc" cx="14" cy="14" r="8" />
                </svg>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {panel.replay && (!fixed || showReplay) ? <ReplayView r={panel.replay} show={showReplay} go={showReplay && (replayOn || !motion)} /> : null}
      {!panel.replay && showReplay ? <p className="no-replay">{NO_REPLAY}</p> : null}

      {!fixed || showLedger ? <Ledger rows={panel.ledger} chapter={chapter} ring={ring} live={panel.mode === "live"} show={showLedger} /> : null}

      <p className="v-foot">Times are UTC.</p>
    </div>
  );
}

// ---- one station ----------------------------------------------------------------------------------------------------------------------------

const inChapter = (t: string, chapter: ChapterNo): boolean => t === String(chapter) || (chapter === 6 && t.startsWith("6"));

function StationView({ st, chapter, fixed, tokens, on, phase, lit, fd, fdl, ringing, ringKey }: { st: Station; chapter: ChapterNo; fixed: boolean; tokens: string[]; on: (l: string[]) => boolean; phase: Phase; lit: boolean; fd?: string; fdl?: string; ringing: boolean; ringKey: number }) {
  const style = { ...(fd ? { "--fd": fd } : {}), ...(fdl ? { "--fdl": fdl } : {}) } as React.CSSProperties;
  return (
    <li className={`st${lit ? " lit" : ""}${ringing ? " ringing" : ""}`} data-k={st.key} style={style}>
      <Mark kind={markOf(st, chapter, phase)} rings={st.key === "doorbell"} ringKey={ringKey} />
      <div className="st-main">
        <div className="st-top">
          <span className="st-name">
            {st.name}
            {st.sub ? <span className="st-sub">{st.sub}</span> : null}
          </span>
          <span className="st-times">
            {st.times
              .filter((t) => !fixed || t.on.some((x) => inChapter(x, chapter)))
              .map((t, k) => (
                <span key={k} className={`fade mono${on(t.on) ? " is-on" : ""}`}>
                  {t.text}
                </span>
              ))}
          </span>
        </div>
        {st.layers
          .filter((l) => !fixed || l.on.some((t) => inChapter(t, chapter)))
          .map((l, k) => (
            <LayerView key={k} layer={l} tokens={tokens} on={on(l.on)} />
          ))}
      </div>
      {st.hop && (!fixed || st.hop.on.some((t) => inChapter(t, chapter))) ? <p className={`hop fade${on(st.hop.on) ? " is-on" : ""}`}>{st.hop.text}</p> : null}
    </li>
  );
}

// The cited line gets the highlighter: an added line, or when the change only removes lines, those. Its indent stays outside the marker.
export function cited(text: string, on: boolean): React.ReactNode {
  if (!on) return text;
  const body = text.trimStart();
  return (
    <>
      {text.slice(0, text.length - body.length)}
      <mark className="cited">{body}</mark>
    </>
  );
}

function LayerView({ layer, tokens, on }: { layer: Layer; tokens: string[]; on: boolean }) {
  const code = layer.code;
  return (
    <div className={`lay${on ? " is-on" : ""}`}>
      <div className="in">
        {code ? (
          <div className="code">
            <p className="code-cap">
              <RichText r={code.caption} />
            </p>
            {code.lines.map((l, k) => {
              // The cited line wears the highlighter: an added line, or, when the change only removes lines, those. A removed line that is not the
              // cited one is struck through; the highlighter and the strike never meet on one line. A long line scrolls inside its own row.
              const hit = l.kind === "add" || !code.lines.some((x) => x.kind === "add");
              return (
                <p key={k} className={`cl ${l.kind === "del" ? "rm" : "ad"}${hit ? " hit" : ""}`}>
                  <span className="ln mono">{`${l.file}${l.no !== null ? `:${l.no}` : ""}`}</span>
                  <span className="sg" aria-label={l.kind === "del" ? "removed" : l.kind === "add" ? "added" : "renamed"}>
                    {l.kind === "del" ? "−" : l.kind === "add" ? "+" : "→"}
                  </span>
                  <code tabIndex={0}>{cited(l.text, hit)}</code>
                </p>
              );
            })}
            <ul className="chk">
              {code.checks.map((c, k) => (
                <li key={k}>
                  <Tick done={c.done} />
                  <span>{c.text}</span>
                </li>
              ))}
            </ul>
            {code.receipt ? <p className="sub">{code.receipt}</p> : null}
          </div>
        ) : (
          <div className="stack">
            {layer.variants.map((v, k) => (
              <div key={k} className={`fade${v.on.length === 0 || v.on.some((t) => tokens.includes(t)) ? " is-on" : ""}`} data-flip={v.flip}>
                {v.lines.map((ln, j) => (
                  <p key={j} className={ln.kind === "sub" ? "sub" : ln.kind === "id" ? "id" : ln.kind === "ghost" ? "ghostline" : undefined}>
                    <RichText r={ln.rich} />
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- the replay -----------------------------------------------------------------------------------------------------------------------------

function ReplayView({ r, show, go }: { r: ReplayModel; show: boolean; go: boolean }) {
  const idx = (n: number) => ({ "--i": n }) as React.CSSProperties;
  const lane = (b: ReplayModel["good"]) => (
    <ol className="lane sts">
      <li className={`st rp-i${b.planted ? "" : " lit"}`} style={idx(2)}>
        <Mark kind="ink" />
        <div className="st-main">
          <span className="st-name">{b.name}</span>
          <span className="st-sub">
            <span className="mono">{b.file}</span>
            {b.planted ? ", planted by us" : ""}
          </span>
          {b.answers.map((a, k) => (
            <p key={k} className={k === 0 ? "l1" : undefined}>
              {a.replace(/\*\*/g, "")}
            </p>
          ))}
        </div>
      </li>
      <li className="st rp-i" style={idx(4)}>
        <Mark kind={b.ok ? "ok" : "bad"} />
        <div className="st-main">
          <span className="st-name">Your books</span>
          <p className="l1">
            <RichText r={b.books} />
          </p>
        </div>
      </li>
    </ol>
  );
  return (
    <div className={`lay w-replay${show ? " is-on" : ""}${go ? " go-replay" : ""}`}>
      <div className="in">
        <div className="rp">
          <div className="rp-i rp-ev" style={idx(0)}>
            <Mark kind="ink" />
            <div className="rp-t">
              <span className="st-name">{r.title}</span>
              <span className="rp-sub">{r.sub}</span>
              {r.ids.map((id) => (
                <span key={id} className="mono">
                  {id}
                </span>
              ))}
            </div>
          </div>
          <div className="rp-i rp-fork" style={idx(1)} aria-hidden="true">
            <span className="fa" />
            <span className="fb" />
          </div>
          <div className="rp-lanes">
            {lane(r.good)}
            {lane(r.bad)}
          </div>
          <p className="rp-i rp-res" style={idx(5)}>
            <Mark kind={r.verdict.confirmed ? "ok" : "wait"} />
            {r.verdict.text}
          </p>
          {r.verdict.note ? <p className="rp-note">{r.verdict.note}</p> : null}
          {r.basis ? <p className="rp-note">{r.basis}</p> : null}
        </div>
      </div>
    </div>
  );
}

// ---- the ledger -----------------------------------------------------------------------------------------------------------------------------

// "no dispute" is the one phrase of the dispute story (lib/ui/dispute-story.ts): the books have the order, and no dispute on file.
export const booksPhrase = (b: string): string => (b === "no entry" ? "books have no entry" : b === "no dispute" ? "books have no dispute" : `books say ${b.split(" ")[0]}`);

type Shown = { kind: "tied" | "gap" | "unverified" | "wait"; books: string; note: string };

// What a row shows: where it started (the fix is deployed, the gaps are open), what the ring has done to it so far, or where the run ended.
export function rowShown(row: LedgerRow, chapter: ChapterNo, ring: RingView, live: boolean): Shown {
  if (live || (chapter >= 6 && ring.stage === "done")) return { kind: row.end.kind, books: row.end.books, note: row.end.note ?? "" };
  const prog = chapter === 6 && ring.stage === "running" ? ring.rows[row.n] : undefined;
  if (prog) return { kind: prog.state === "wait" ? "wait" : prog.state === "tied" ? "tied" : "gap", books: prog.state === "tied" ? row.end.books : row.start.books, note: prog.note };
  return { kind: row.start.kind, books: row.start.books, note: "" };
}

export const WORD = { tied: "Tied", gap: "Gap", unverified: "Not provable yet", wait: "Ringing" } as const;
export const MARK = { tied: "ok", gap: "bad", unverified: "wait", wait: "wait" } as const;

function Ledger({ rows, chapter, ring, live, show }: { rows: LedgerRow[]; chapter: ChapterNo; ring: RingView; live: boolean; show: boolean }) {
  return (
    <div className={`lay w-ledger${show ? " is-on" : ""}`}>
      <div className="in">
        <div className="ledger">
          <ul>
            {rows.map((row) => {
              const s = rowShown(row, chapter, ring, live);
              const flips = row.ring !== null && row.start.books !== row.end.books;
              const after = flips && s.books === row.end.books;
              return (
                <li key={row.n} className="row" data-o={row.n}>
                  <Mark kind={MARK[s.kind]} />
                  <div className="r-main">
                    <p className="r-item">{`#${row.n} ${row.item}`}</p>
                    <p className="r-says">
                      <span className="r-pp">PayPal says {row.paypal}</span>
                      <span className="r-bk">
                        {flips ? (
                          <span className="stack">
                            <span className={`fade${after ? "" : " is-on"}`} data-flip="from">
                              {booksPhrase(row.start.books)}
                            </span>
                            <span className={`fade${after ? " is-on" : ""}`} data-flip="to">
                              {booksPhrase(row.end.books)}
                            </span>
                          </span>
                        ) : (
                          booksPhrase(s.books)
                        )}
                      </span>
                    </p>
                    <p className="r-note">{s.note}</p>
                  </div>
                  <div className="r-right">
                    <span className="r-amt">{row.amount}</span>
                    <span className="r-word" data-s={s.kind}>
                      {WORD[s.kind]}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
