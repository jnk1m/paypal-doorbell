"use client";
// The incident story, played back (S5 design, R12): a left column of chapters, ONE sticky panel on the right that draws the path and redraws
// for each chapter, and under them the list of all captures. It plays a recorded run and makes no request: the stories arrive with the page.
// Four recorded scenarios share the same seven chapters; a labelled select in the top bar switches between them. The fourth is the one where the
// AI cannot name a cause: its replay chapter has nothing to show (the panel says so in one quiet line) and its tab is off.
//
// Rhythm (wide): a chapter is about three quarters of a window tall and its headline starts at the height of the panel's first node, so that a
// reader who scrolls to a chapter finds the text and the path at the same height. The panel changes when the next headline has risen to 60% of
// the window, which is when that text is the thing being read.
//
// Ring again plays the REAL ring (lib/ui/ring.ts): the resends, the waits and the arrival time are the heal data of the recording, with long
// waits shortened and said so in small text. With reduced motion the end state shows at once.
//
// A phone (narrow) is not the wide layout in one column: the path is a strip pinned to the top (path-strip.tsx, the sticky panel in one row; tapping it
// opens the full path in a bottom sheet, path-sheet.tsx), and each chapter is its headline, one sentence, one piece of evidence and a "More"
// (phone-story.tsx). The first paint holds both layouts and the stylesheet shows the one that fits; the page then keeps the one it measured.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CHAPTERS, type ChapterNo, type Story } from "../../lib/ui/story.ts";
import { IDLE_RING, applyBeat, finalRing, ringBeats, type RingView } from "../../lib/ui/ring.ts";
import { CapturesList } from "./captures-list.tsx";
import { FixProofBlock } from "./fix-proof.tsx";
import { Tick } from "./marks.tsx";
import { PathPanel } from "./path-panel.tsx";
import { PathSheet } from "./path-sheet.tsx";
import { PathStrip } from "./path-strip.tsx";
import { PhoneChapters } from "./phone-story.tsx";
import { RichText } from "./rich-text.tsx";
import { SiteFooter } from "./site-footer.tsx";
import { SwapHeading } from "./swap-heading.tsx";
import { TopBar } from "./top-bar.tsx";
import { useLayout, useMotion, type Layout } from "./use-env.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface StoryViewProps {
  stories: Story[];
  start?: number; // which story opens (tests); the page itself opens on the first, or on the one the address names (?s=)
  layout?: Layout; // tests render one layout
  notice?: string; // a sentence for the top bar: why this is the recorded run (the live lane fell back to it)
  ring?: RingView; // tests: render the page in a ring state
}

export function StoryView({ stories, start = 0, layout: forced, notice, ring: forcedRing }: StoryViewProps) {
  const [si, setSi] = useState(start);
  const [chapter, setChapter] = useState<ChapterNo>(1);
  const [ring, setRing] = useState<RingView>(forcedRing ?? IDLE_RING);
  const layout = useLayout(forced);
  const motion = useMotion();
  const main = useRef<HTMLElement>(null);
  const player = useRef(0);
  const slot = useRef<HTMLParagraphElement>(null); // the paragraph under the headline of Ring again: the instruction, then the result
  const [slotH, setSlotH] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const strip = useRef<HTMLButtonElement>(null);

  const story = stories[si];
  const panel = story.panel;
  const focalN = panel.subject?.n ?? null;

  // A link like /?s=signature_rejected opens that scenario. The page is rendered once, the same for everyone, and this moves it.
  // The address is read once and kept: the effect below rewrites it, and a second run of this one (React's development double run) must not read that.
  const linked = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (linked.current === undefined) linked.current = new URLSearchParams(window.location.search).get("s");
    const i = stories.findIndex((s) => s.id === linked.current);
    if (i >= 0) setSi(i);
  }, [stories]);

  // Keep the address in step with the scenario on screen (no navigation, no request).
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("s", story.id);
      window.history.replaceState(null, "", url);
    } catch {
      // an address that cannot be rewritten (a sandboxed frame) only loses the deep link
    }
  }, [story.id]);

  // The sticky panel follows the last chapter whose headline has risen above 60% of the window: when the next text comes into reading
  // position the panel already shows it (a headline watched as it crosses that line wakes the check; the check reads every headline).
  useEffect(() => {
    if (layout === "narrow" || !main.current) return;
    const heads = CHAPTERS.map((c) => document.getElementById(`t${c.no}`));
    const check = () => {
      let now: ChapterNo = 1;
      heads.forEach((h, i) => {
        // a headline that is not on screen at all (the first paint holds both layouts, and a phone hides this one) has not risen
        if (h && h.offsetParent !== null && h.getBoundingClientRect().top < window.innerHeight * 0.6) now = CHAPTERS[i].no;
      });
      setChapter(now);
    };
    const io = new IntersectionObserver(check, { rootMargin: "0px 0px -40% 0px", threshold: 0 });
    heads.forEach((h) => h && io.observe(h));
    check();
    return () => io.disconnect();
  }, [layout, story.id]);

  // The strip follows the last chapter whose headline has passed a line a little below the middle of the free space under it; at the bottom of the page it is the last.
  useEffect(() => {
    if (layout !== "narrow" || !main.current) return;
    const heads = CHAPTERS.map((c) => document.getElementById(`mt${c.no}`));
    let frame = 0;
    const check = () => {
      frame = 0;
      const height = strip.current?.offsetHeight ?? 0;
      const line = height + (window.innerHeight - height) * 0.55;
      let now: ChapterNo = 1;
      heads.forEach((h, i) => {
        if (h && h.getBoundingClientRect().top <= line) now = CHAPTERS[i].no;
      });
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) now = 7;
      setChapter(now);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    check();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [layout, story.id]);

  // The sheet gives the focus back to the strip that opened it.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !sheetOpen) strip.current?.focus({ preventScroll: true });
    wasOpen.current = sheetOpen;
  }, [sheetOpen]);

  // A chapter's headline starts at the height of the panel's first node when the reader scrolls to the chapter (the tabs do): the stylesheet
  // takes the distance from --lead-in, and this measures it, because the height of the panel's own header depends on the width of the window.
  useEffect(() => {
    const m = main.current;
    if (layout === "narrow" || !m) return;
    const align = () => {
      const aside = m.querySelector<HTMLElement>(".aside");
      const mark = aside?.querySelector<HTMLElement>(".st .mk");
      const head = document.getElementById("t2");
      if (!aside || !mark || !head || aside.offsetParent === null) return;
      const stuck = parseFloat(getComputedStyle(aside).top) || 0;
      const r = mark.getBoundingClientRect();
      const nodeY = stuck + r.top - aside.getBoundingClientRect().top + r.height / 2;
      const bar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar-h")) || 56;
      const line = parseFloat(getComputedStyle(head).lineHeight) || 0;
      m.style.setProperty("--lead-in", `${Math.max(0, Math.round(nodeY - bar - line / 2))}px`);
    };
    align();
    window.addEventListener("resize", align);
    void document.fonts?.ready.then(align);
    return () => window.removeEventListener("resize", align);
  }, [layout, story.id]);

  const stop = useCallback(() => {
    player.current++;
  }, []);

  const reset = useCallback(() => {
    stop();
    setRing(IDLE_RING);
    setSlotH(null);
  }, [stop]);

  const play = useCallback(async () => {
    if (ring.stage !== "idle") return;
    const beats = ringBeats(panel.ledger, focalN, story.ring.result);
    if (beats.length === 0) return;
    setSlotH(slot.current?.offsetHeight ?? null); // the result takes the place of the instruction and keeps its height
    if (!motion) {
      setRing(finalRing(panel.ledger, focalN, story.ring.result));
      return;
    }
    const id = ++player.current;
    let view = IDLE_RING;
    for (const b of beats) {
      await sleep(b.after);
      if (player.current !== id) return;
      view = applyBeat(view, b);
      setRing(view);
    }
  }, [ring.stage, panel.ledger, focalN, story.ring.result, motion]);

  const pick = (i: number) => {
    reset();
    setSi(i);
    setChapter(1);
    setSheetOpen(false);
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  const go = (ch: ChapterNo) => document.getElementById(`c${ch}`)?.scrollIntoView({ behavior: motion ? "smooth" : "auto", block: "start" });

  const done = ring.stage === "done";
  const focalTied = focalN !== null && ring.rows[focalN]?.state === "tied";
  const cert = done ? story.cert.after : story.cert.before;
  const green = done && story.certGreen;
  const wide = layout !== "narrow";
  const narrow = layout !== "wide";
  const canRing = panel.available[6] && panel.ledger.some((r) => r.ring);
  // every headline the ring chapter can show (the keys that start with h: before, after, and any in between), to reserve the room of the longest
  const ringHeadings = [...new Set(Object.entries(story.ring).flatMap(([k, v]) => (/^h[A-Z]/.test(k) && typeof v === "string" ? [v] : [])))];

  const select = useMemo(
    () =>
      stories.length > 1 ? (
        <div className="scn">
          <label htmlFor="scenario">Scenario</label>
          <select id="scenario" value={si} onChange={(e) => pick(Number(e.target.value))}>
            {stories.map((s, i) => (
              <option key={s.id} value={i}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      ) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stories, si],
  );

  return (
    <>
      {/* everything but the sheet: the sheet makes it inert while it is open */}
      <div className="page" inert={sheetOpen} data-cert={green ? "green" : "none"}>
        <TopBar bar={story.bar} notice={notice} link={{ href: "/live", label: "Run it live" }}>
          {select}
        </TopBar>
        {narrow ? <PathStrip ref={strip} panel={panel} chapter={chapter} ring={ring} motion={motion} open={sheetOpen} onOpen={() => setSheetOpen(true)} /> : null}

        <main id="main" className="stage" data-cert={green ? "green" : "none"} ref={main} key={story.id}>
          {wide ? (
            <div className="narr narr-w">
              <section className="chap" id="c1" data-ch="1" aria-labelledby="t1">
                <div className="copy">
                  <h1 className="focal xl" id="t1">
                    {story.focal.h}
                  </h1>
                  <p className="lead">
                    <RichText r={story.focal.lead} />
                  </p>
                  {story.focal.body.map((p, i) => (
                    <p className="body" key={i}>
                      <RichText r={p} />
                    </p>
                  ))}
                  {story.focal.found ? (
                    <p className="body">
                      <RichText r={story.focal.found} />
                    </p>
                  ) : null}
                  <p className="body">
                    <RichText r={story.focal.pitch} />
                  </p>
                </div>
              </section>

              {(
                [
                  [2, story.travel],
                  [3, story.why],
                  [4, story.replay],
                  [5, story.fix],
                ] as const
              ).map(([n, c]) => (
                <section className="chap" id={`c${n}`} data-ch={n} aria-labelledby={`t${n}`} key={n}>
                  <div className="copy">
                    <h2 className="focal" id={`t${n}`}>
                      {c.h}
                    </h2>
                    {c.body.map((p, i) => (
                      <p className="body" key={i}>
                        <RichText r={p} />
                      </p>
                    ))}
                    {n === 5 && story.fix.proof ? <FixProofBlock proof={story.fix.proof} /> : null}
                  </div>
                </section>
              ))}

              <section className="chap" id="c6" data-ch="6" aria-labelledby="t6">
                <div className="copy">
                  <SwapHeading id="t6" text={done ? story.ring.hAfter : focalTied ? story.ring.hDuring : story.ring.hBefore} reserve={ringHeadings} motion={motion} />
                  <p className="body" ref={slot} aria-live="polite" style={slotH !== null ? { minHeight: slotH } : undefined}>
                    {done ? story.ring.result : <RichText r={story.ring.body} />}
                  </p>
                  {canRing ? (
                    <div className="ring-ui">
                      <div className="ring-act">
                        <div className="ring-btns">
                          <button className="btn" id="ring" type="button" disabled={ring.stage !== "idle"} hidden={done} onClick={() => void play()}>
                            {ring.stage === "idle" ? "Ring again" : "Ringing…"}
                          </button>
                          <button className="btn-text" id="reset" type="button" hidden={!done} onClick={reset}>
                            Start over
                          </button>
                        </div>
                        {ring.stage === "running" ? <p className="ring-tag">Replaying a recording</p> : null}
                      </div>
                      <div className="ring-msg">
                        <p className="small">{story.ring.note}</p>
                        {story.ring.noteDetail ? <p className="small">{story.ring.noteDetail}</p> : null}
                        <p className="small" role="status">
                          {ring.stage === "running" ? ring.announce : ""}
                        </p>
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>

              <section className="chap" id="c7" data-ch="7" aria-labelledby="t7">
                <div className="copy">
                  <h2 className="focal" id="t7">
                    {cert.focal}
                  </h2>
                  <p className="lead">{cert.lead}</p>
                  <h3>First, what Doorbell cannot prove</h3>
                  <ul className="list dash">
                    {cert.cannot.map((r, i) => (
                      <li key={i}>
                        <RichText r={r} />
                      </li>
                    ))}
                  </ul>
                  <h3>What it did check</h3>
                  <ul className="list ticks">
                    {cert.checks.map((c, i) => (
                      <li key={i}>
                        <Tick done={c.done} />
                        <RichText r={c.rich} />
                      </li>
                    ))}
                  </ul>
                  <p className="body">
                    <a href={`/certificate?s=${story.id}`}>Open the owner view</a>, a printable page in plain sentences.
                  </p>
                </div>
              </section>
            </div>
          ) : null}
          {narrow ? <PhoneChapters story={story} ring={ring} motion={motion} canRing={canRing} onRing={() => void play()} onReset={reset} /> : null}
          {wide ? (
            <aside className="aside" aria-label={panel.subject ? `The delivery path for ${panel.subject.label.toLowerCase()}` : "The delivery path"}>
              <PathPanel panel={panel} chapter={chapter} ring={ring} motion={motion} onGo={go} />
            </aside>
          ) : null}
        </main>

        <CapturesList rows={done ? story.captures.after : story.captures.before} />
        <SiteFooter />
      </div>
      {narrow ? <PathSheet open={sheetOpen} onClose={() => setSheetOpen(false)} panel={panel} chapter={chapter} ring={ring} motion={motion} green={green} /> : null}
    </>
  );
}

export { CHAPTERS };
