"use client";
// The seven chapters as a phone prints them: each is its headline, ONE sentence, ONE piece of evidence and a single quiet "More" that holds the
// rest of the chapter's text (a <details>: nothing is cut, only folded). The sentence, the evidence and the folded text are the story's phone copy
// (Story.phone, lib/ui/story.ts) and the panel's own data; the path is the strip pinned above them (app/_components/path-strip.tsx).
//   1  what PayPal says against what the books say   2  the event, row by row, with its times   3  the cited change, with the checks and the AI's receipt
//   4  the two builds side by side                   5  the patch Claude proposed and its verdict, or with none the handler line before and now
//   6  the button and the orders                     7  what it cannot prove
import type { RingView } from "../../lib/ui/ring.ts";
import type { PhoneRow, PhoneSide, Story } from "../../lib/ui/story.ts";
import { FixCaption, FixDetails, FixDiff, FixVerdict } from "./fix-proof.tsx";
import { Mark, Tick } from "./marks.tsx";
import { MARK, NO_REPLAY, WORD, booksPhrase, cited, rowShown } from "./path-panel.tsx";
import { RichText } from "./rich-text.tsx";
import { SwapHeading } from "./swap-heading.tsx";

function More({ label = "More", children }: { label?: string; children: React.ReactNode }) {
  return (
    <details className="pc-more">
      <summary>
        <span className="pm" aria-hidden="true" />
        <span className="lb">{label}</span>
      </summary>
      <div className="mb">{children}</div>
    </details>
  );
}

const Paras = ({ r }: { r: Story["phone"]["c1"]["more"] }) => (
  <>
    {r.map((p, i) => (
      <p key={i}>
        <RichText r={p} />
      </p>
    ))}
  </>
);

function Side({ s }: { s: PhoneSide }) {
  return (
    <div className="side">
      <p className="who">{s.who}</p>
      <p className="val">
        <Mark kind={s.mark} />
        {s.word}
      </p>
      {s.amount ? <p className="amt">{s.amount}</p> : null}
    </div>
  );
}

function Rail({ rows }: { rows: PhoneRow[] }) {
  return (
    <>
      {rows.map((r, i) => (
        <li key={i} className={`${r.dashed ? "dash" : ""}${r.mark ? " nx" : ""}`.trim() || undefined}>
          <span className="t">{r.t ?? "—"}</span>
          <span className="d">{r.mark ? <Mark kind={r.mark} /> : null}</span>
          <span className="x">
            <RichText r={r.x} />
          </span>
        </li>
      ))}
    </>
  );
}

export interface PhoneChaptersProps {
  story: Story;
  ring: RingView;
  motion: boolean;
  canRing: boolean;
  onRing: () => void;
  onReset: () => void;
}

export function PhoneChapters({ story, ring, motion, canRing, onRing, onReset }: PhoneChaptersProps) {
  const { panel, phone: p } = story;
  const done = ring.stage === "done";
  const focalN = panel.subject?.n ?? null;
  const focalTied = focalN !== null && ring.rows[focalN]?.state === "tied";
  const cert = done ? p.cert.after : p.cert.before;
  const ringHeadings = [...new Set(Object.entries(story.ring).flatMap(([k, v]) => (/^h[A-Z]/.test(k) && typeof v === "string" ? [v] : [])))];
  const shop = panel.stations.find((st) => st.key === "shop");
  const whyLayer = shop?.layers.find((l) => l.on.includes("3"));
  const code = whyLayer?.code ?? null;
  const quiet = whyLayer?.variants[0]?.lines ?? [];
  const replay = panel.replay;
  const [vsPaypal, vsBooks] = p.c1.vs;

  return (
    <div className="narr-m">
      <section className="pch" id="m1" data-ch="1" aria-labelledby="mt1">
        <h1 className="focal" id="mt1">
          {story.focal.h}
        </h1>
        <div className="pc-ev pc-vs" role="group" aria-label={`${vsPaypal.who} ${vsPaypal.word}${vsPaypal.amount ? ` ${vsPaypal.amount}` : ""}. ${vsBooks.who} ${vsBooks.word}${vsBooks.amount ? ` ${vsBooks.amount}` : ""}.`}>
          <Side s={vsPaypal} />
          <div className="gap" aria-hidden="true">
            <span className="ne">
              <svg viewBox="0 0 18 18">
                <path d="M3 6.5h12M3 11.5h12M11.5 2.5l-5 13" />
              </svg>
            </span>
          </div>
          <Side s={vsBooks} />
        </div>
        <p className="pc-cap">
          <RichText r={p.c1.caption} />
        </p>
        <p className="pc-sent">
          {p.c1.beats.map((b, i) => (
            <span className="beat" key={i}>
              <RichText r={b} />
            </span>
          ))}
        </p>
        <More>
          <Paras r={p.c1.more} />
        </More>
      </section>

      <section className="pch" id="m2" data-ch="2" aria-labelledby="mt2">
        <h2 className="focal" id="mt2">
          {story.travel.h}
        </h2>
        <p className="pc-sent">
          <RichText r={p.c2.short} />
        </p>
        <ol className="pc-ev pc-tl" aria-label={`What happened to the ${panel.subject?.eventWord ?? "event"} for ${panel.subject?.label.toLowerCase() ?? "this order"}, times in UTC`}>
          <Rail rows={p.c2.rows} />
        </ol>
        <More>
          <Paras r={p.c2.more} />
        </More>
      </section>

      <section className="pch" id="m3" data-ch="3" aria-labelledby="mt3">
        <h2 className="focal" id="mt3">
          {story.why.h}
        </h2>
        <p className="pc-sent">
          <RichText r={p.c3.short} />
        </p>
        <div className="pc-ev" role="group" aria-label={code ? "The change the AI cited" : "What the AI could say about the cause"}>
          {code ? (
            <>
              <p className="pc-cap">
                <RichText r={code.caption} />
              </p>
              <div className="pc-code cited-on" tabIndex={0} role="region" aria-label="The cited change, scrolls sideways">
                <div className="cb">
                  {code.lines.map((l, i) => {
                    // the cited line wears the highlighter: an added line, or, when the change only removes lines, those
                    const hit = l.kind === "add" || !code.lines.some((x) => x.kind === "add");
                    const label = `${l.file}${l.no !== null ? `:${l.no}` : ""}`;
                    return (
                      <div className="cb-line" key={i}>
                        <span className="fl">{label}</span>
                        <p className={`pcl ${l.kind === "del" ? "rm" : "ad"}${hit ? " hit" : ""}`}>
                          <span className="sg" aria-label={l.kind === "del" ? "removed" : l.kind === "add" ? "added" : "renamed"}>
                            {l.kind === "del" ? "−" : l.kind === "add" ? "+" : "→"}
                          </span>
                          <code>{cited(l.text, hit)}</code>
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
              <ul className="pc-chk">
                {code.checks.map((c, i) => (
                  <li key={i}>
                    <Tick done={c.done} />
                    <span>{c.text}</span>
                  </li>
                ))}
              </ul>
              {code.receipt ? <p className="pc-receipt">{code.receipt}</p> : null}
            </>
          ) : (
            <div className="pc-quiet">
              <Mark kind={whyLayer?.mark ?? "wait"} />
              <div>
                {quiet.map((ln, i) => (
                  <p key={i} className={ln.kind === "sub" ? "s" : "t"}>
                    <RichText r={ln.rich} />
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
        {p.c3.more.length > 0 ? (
          <More>
            <Paras r={p.c3.more} />
          </More>
        ) : null}
      </section>

      <section className="pch" id="m4" data-ch="4" aria-labelledby="mt4">
        <h2 className="focal" id="mt4">
          {story.replay.h}
        </h2>
        <p className="pc-sent">
          <RichText r={p.c4.short} />
        </p>
        {replay ? (
          <>
            <div className="pc-ev pc-lanes" role="group" aria-label={`Replay result. ${replay.good.name}: ${replay.good.statuses.join(", ")}, books say ${replay.good.booksShort}. ${replay.bad.name}: ${replay.bad.statuses.join(", ")}, books say ${replay.bad.booksShort}.`}>
              {[replay.good, replay.bad].map((b) => (
                <div className="pc-lane" key={b.name}>
                  <p className="ln-h">{b.name}</p>
                  <p className="ln-f">
                    <span className="mono">{b.file}</span>
                    {b.planted ? ", planted by us" : ""}
                  </p>
                  <p className="ln-a">{b.statuses.length > 0 ? `Answers ${b.statuses.join(", ")}` : "Gave no answer"}</p>
                  <p className="ln-k">Books say</p>
                  <p className="ln-b">
                    <Mark kind={b.ok ? "ok" : "bad"} />
                    {b.booksShort}
                  </p>
                  {b.booksShort !== "No entry" && panel.subject ? <p className="ln-amt">{panel.subject.amount}</p> : null}
                </div>
              ))}
            </div>
            <p className="pc-res">
              <Mark kind={replay.verdict.confirmed ? "ok" : "wait"} />
              <span>
                <span className="r1">{replay.verdict.text}</span>
                {replay.verdict.note || replay.basis ? <span className="r2">{replay.verdict.note ?? replay.basis}</span> : null}
              </span>
            </p>
          </>
        ) : (
          <p className="pc-none">
            <Mark kind="ghost" />
            <span>{NO_REPLAY}</span>
          </p>
        )}
        {p.c4.more.length > 0 ? (
          <More>
            <Paras r={p.c4.more} />
          </More>
        ) : null}
      </section>

      <section className="pch" id="m5" data-ch="5" aria-labelledby="mt5">
        <h2 className="focal" id="mt5">
          {p.c5.h}
        </h2>
        {p.c5.short.length > 0 ? (
          <p className="pc-sent">
            <RichText r={p.c5.short} />
          </p>
        ) : null}
        <div className="pc-ev" role="group" aria-label={p.c5.proof ? "The patch Claude proposed, its verdict, and what the books say" : "The handler line before and now, and what the books say"}>
          {p.c5.proof ? (
            <>
              <FixCaption proof={p.c5.proof} />
              <FixDiff proof={p.c5.proof} />
              {p.c5.proof.legend ? <p className="fx-legend">{p.c5.proof.legend}</p> : null}
              <FixVerdict proof={p.c5.proof} />
            </>
          ) : null}
          {p.c5.change ? (
            <ul className="pc-ba">
              {(["before", "now"] as const).map((side) => {
                const c = p.c5.change!;
                const lines = c.kind === "code" ? c[side] : null;
                return (
                  <li key={side}>
                    <span className="k">{side === "before" ? "Before" : "Now"}</span>
                    {c.kind === "setting" ? (
                      <span className="txt">{c[side]}</span>
                    ) : lines ? (
                      <span className="codes">
                        {lines.map((t, i) => (
                          <code key={i} tabIndex={0}>
                            {side === "now" ? <mark>{t}</mark> : t}
                          </code>
                        ))}
                      </span>
                    ) : (
                      <span className="txt">{side === "before" ? "Missing" : "Removed"}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <p className="pc-stays">
            <Mark kind="bad" />
            <span>
              <RichText r={p.c5.books} />
            </span>
          </p>
        </div>
        <More>
          <Paras r={p.c5.more} />
          {p.c5.proof ? (
            <>
              <p>
                <RichText r={p.c5.proof.lede} />
              </p>
              <FixDetails proof={p.c5.proof} noteInDetails />
            </>
          ) : null}
        </More>
      </section>

      <section className="pch" id="m6" data-ch="6" aria-labelledby="mt6">
        <SwapHeading id="mt6" text={done ? story.ring.hAfter : focalTied ? story.ring.hDuring : story.ring.hBefore} reserve={ringHeadings} motion={motion} />
        <p className="pc-sent">
          <RichText r={p.c6.short} />
        </p>
        <div className="pc-ev">
          {canRing ? (
            <div className="pc-ring">
              <div className="ring-btns">
                <button className="btn" id="ring-m" type="button" disabled={ring.stage !== "idle"} hidden={done} onClick={onRing}>
                  {ring.stage === "idle" ? "Ring again" : "Ringing…"}
                </button>
                <button className="btn-text" id="reset-m" type="button" hidden={!done} onClick={onReset}>
                  Start over
                </button>
              </div>
              <p className="pc-note">{story.ring.note}</p>
              <p className="sr" role="status">
                {ring.stage === "running" ? ring.announce : ""}
              </p>
            </div>
          ) : null}
          <ul className="pc-ledger" aria-label="The orders of this run">
            {panel.ledger.map((row) => {
              const s = rowShown(row, 6, ring, panel.mode === "live");
              const flips = row.ring !== null && row.start.books !== row.end.books;
              const after = flips && s.books === row.end.books;
              return (
                <li key={row.n} className="pl-row" data-o={row.n}>
                  <Mark kind={MARK[s.kind]} />
                  <p className="pl-item">{`#${row.n} ${row.item}`}</p>
                  <p className="pl-right">
                    <span className="pl-amt">{row.amount}</span>
                    <span className="pl-word" data-s={s.kind}>
                      {WORD[s.kind]}
                    </span>
                  </p>
                  <p className="pl-says">
                    <span>PayPal says {row.paypal}</span>
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
                      <span>{booksPhrase(s.books)}</span>
                    )}
                  </p>
                  <p className="pl-note">{s.note}</p>
                </li>
              );
            })}
          </ul>
        </div>
        <More>
          <Paras r={p.c6.more} />
          {story.ring.noteDetail ? <p>{story.ring.noteDetail}</p> : null}
          {done ? <p>{story.ring.result}</p> : null}
        </More>
      </section>

      <section className="pch" id="m7" data-ch="7" aria-labelledby="mt7">
        <h2 className="focal" id="mt7">
          {cert.focal}
        </h2>
        <p className="pc-sent">{cert.lead}</p>
        <div className="pc-ev">
          <h3 className="pc-h">First, what Doorbell cannot prove</h3>
          <ul className="list dash">
            {cert.cannot.map((r, i) => (
              <li key={i}>
                <RichText r={r} />
              </li>
            ))}
          </ul>
        </div>
        <More label="What it checked">
          <ul className="list ticks">
            {cert.checks.map((c, i) => (
              <li key={i}>
                <Tick done={c.done} />
                <RichText r={c.rich} />
              </li>
            ))}
          </ul>
        </More>
        <p className="pc-link">
          <a href={`/certificate?s=${story.id}`}>Open the owner view</a>
          <span>, a printable page in plain sentences.</span>
        </p>
      </section>
    </div>
  );
}
