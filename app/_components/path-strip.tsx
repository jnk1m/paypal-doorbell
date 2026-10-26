"use client";
// The phone's path strip: PayPal, Doorbell, your shop, your books, pinned to the top of the screen, with a few characters under each stop. It is the
// desktop's sticky panel in one row. What it shows at rest comes from lib/ui/strip.ts (the same Panel, the same marks); this file adds the motion that
// means something, all of it played from the same inputs as the panel's:
//   chapter 2: the message travels from PayPal to Doorbell to the shop, filling the road behind it;
//   chapter 4: the stops fork into the good build and the bad build, and each build's books say what they say;
//   Ring again: a ripple at Doorbell, the message going out to PayPal and coming back to the shop and the books (the seconds counted on the dot);
//   the books flip from Paid to Refunded when the resend is saved.
// With reduced motion every one of them shows its end state at once. Nothing here makes a request. Tapping the strip opens the full path
// (app/_components/path-sheet.tsx); the stops are not buttons of their own.
import { useEffect, useMemo, useRef, useState } from "react";
import type { RingView } from "../../lib/ui/ring.ts";
import { FORK_LINKS, PATH_LINKS, STOP_KEYS, stripScene, type StripScene, type StopKey } from "../../lib/ui/strip.ts";
import type { ChapterNo, MarkKind, Panel } from "../../lib/ui/story.ts";
import { Mark } from "./marks.tsx";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const TIME = /^\d\d:\d\d/;

interface Pt {
  x: number;
  y: number;
}
interface Place {
  x: number;
  y: number;
  on: boolean;
}
interface Geom {
  stops: Record<StopKey, Place>;
  links: Record<string, string>;
}

// Where the stops stand: four equal columns when it is a path, and the fork's three columns (the event, the two builds, their books) when it is a replay.
function geom(mode: "path" | "fork", W: number): Geom {
  const c = W / 4;
  if (mode === "path") {
    const xs = [0.5, 1.5, 2.5, 3.5].map((i) => i * c);
    return {
      stops: { pp: { x: xs[0], y: 0, on: true }, db: { x: xs[1], y: 0, on: true }, sh: { x: xs[2], y: 0, on: true }, bk: { x: xs[3], y: 0, on: true }, shB: { x: xs[2], y: 0, on: false }, bkB: { x: xs[3], y: 0, on: false } },
      links: { "pp-db": `M${xs[0] + 15} 12H${xs[1] - 15}`, "db-sh": `M${xs[1] + 15} 12H${xs[2] - 15}`, "sh-bk": `M${xs[2] + 15} 12H${xs[3] - 15}` },
    };
  }
  const xA = Math.round(W * 0.17) + 12;
  const xK = Math.round(W * 0.6) + 12;
  const xe = xA + 100;
  return {
    stops: { pp: { x: 12, y: 18, on: false }, db: { x: 12, y: 18, on: true }, sh: { x: xA, y: 3, on: true }, shB: { x: xA, y: 33, on: true }, bk: { x: xK, y: 3, on: true }, bkB: { x: xK, y: 33, on: true } },
    links: { "db-A": `M26 30H38V15H${xA - 15}`, "db-B": `M26 30H38V45H${xA - 15}`, "A-K": `M${xe} 15H${xK - 15}`, "B-K": `M${xe} 45H${xK - 15}` },
  };
}

// A text that changes goes out first and the new one comes in after it: two words in one place are never both on screen.
function Swap({ text, motion }: { text: string; motion: boolean }) {
  const [shown, setShown] = useState(text);
  const [out, setOut] = useState(false);
  useEffect(() => {
    if (text === shown) {
      setOut(false);
      return;
    }
    if (!motion || !shown || !text) {
      setShown(text);
      setOut(false);
      return;
    }
    setOut(true);
    const t = setTimeout(() => {
      setShown(text);
      setOut(false);
    }, 140);
    return () => clearTimeout(t);
  }, [text, shown, motion]);
  return <span className={`sp-sw${out ? " out" : ""}`}>{shown}</span>;
}

export interface PathStripProps {
  panel: Panel;
  chapter: ChapterNo;
  ring: RingView;
  motion: boolean;
  open: boolean; // the full path is open: the strip says so
  onOpen: () => void;
  ref?: React.Ref<HTMLButtonElement>;
}

type Anim = Record<string, { d: number; dl: number }>;

export function PathStrip({ panel, chapter, ring, motion, open, onOpen, ref }: PathStripProps) {
  const rail = useRef<HTMLSpanElement>(null);
  const dots = useRef<Record<"a" | "b", HTMLSpanElement | null>>({ a: null, b: null });
  const epoch = useRef(0);
  const widthRef = useRef(0);
  const [W, setW] = useState(0);
  const [settled, setSettled] = useState(false); // the stops slide between places only once they have stood in their first ones

  // while Ring again runs the strip draws the ring's picture wherever the reader has scrolled: the chapter it follows is 6
  const effChapter: ChapterNo = ring.stage === "running" ? 6 : chapter;
  const target = useMemo(() => stripScene(panel, effChapter, ring), [panel, effChapter, ring]);
  const [paint, setPaint] = useState<StripScene>(target);
  const [anim, setAnim] = useState<Anim>({});
  const focalRing = panel.ledger.find((r) => r.n === panel.subject?.n)?.ring ?? null;

  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const read = () => {
      widthRef.current = el.clientWidth;
      setW(el.clientWidth);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!W) return;
    setSettled(false);
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setSettled(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [W]);

  useEffect(() => {
    const my = ++epoch.current;
    const ok = (): boolean => epoch.current === my;
    const D = dots.current;
    const pos = (mode: "path" | "fork", k: StopKey): Pt => {
      const p = geom(mode, widthRef.current || 320).stops[k];
      return { x: p.x, y: p.y + 12 };
    };
    const at = (d: HTMLSpanElement, p: Pt) => {
      d.style.transform = `translate(${p.x}px,${p.y}px)`;
    };
    const show = (d: HTMLSpanElement, on: boolean, small: boolean) => {
      d.style.opacity = on ? "1" : "0";
      d.classList.toggle("sm", small);
    };
    const hideDots = () => {
      for (const d of [D.a, D.b]) {
        if (!d) continue;
        d.getAnimations().forEach((a) => a.cancel());
        d.style.opacity = "0";
      }
    };
    const fly = (d: HTMLSpanElement, pts: Pt[], ms: number, ease?: string): Promise<void> => {
      const last = pts[pts.length - 1];
      if (!ms) {
        at(d, last);
        return Promise.resolve();
      }
      const len = [0];
      for (let i = 1; i < pts.length; i++) len[i] = len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      const total = len[len.length - 1] || 1;
      const frames = pts.map((p, i) => ({ transform: `translate(${p.x}px,${p.y}px)`, offset: len[i] / total }));
      const a = d.animate(frames, { duration: ms, easing: ease ?? "linear", fill: "forwards" });
      return a.finished.then(() => {
        at(d, last);
        a.cancel();
      }, () => undefined);
    };
    const light = (id: string, d: number, dl = 0) => setAnim((a) => ({ ...a, [id]: { d, dl } }));
    const rest = () => {
      hideDots();
      setAnim({});
      setPaint(target);
    };

    // a scene with only the first `n` stops of the path known yet
    const known = (n: number, lit: string[], active: StopKey[]): StripScene => {
      const order: StopKey[] = ["pp", "db", "sh", "bk"];
      const stops = { ...target.stops };
      order.forEach((k, i) => {
        stops[k] = i < n ? { ...target.stops[k], active: active.includes(k) } : { ...target.stops[k], mark: "ghost" as MarkKind, value: "", active: false };
      });
      return { ...target, stops, lit };
    };

    // [Track UI-B] a message that was never sent does not travel: a dispute nobody was listening for (Panel.reach 0) has no chapter-2 journey to play
    if (!motion || (target.mode === "path" && effChapter !== 2 && effChapter !== 6) || (effChapter === 6 && ring.stage === "idle") || (effChapter === 2 && panel.reach === 0)) {
      rest();
      return () => {
        epoch.current++;
      };
    }

    void (async () => {
      hideDots();
      setAnim({});

      // chapter 2: the message travels from PayPal to Doorbell to the shop, and the books are still what they were
      if (effChapter === 2 && panel.available[2]) {
        const P = (k: StopKey) => pos("path", k);
        setPaint(known(1, [], ["pp"]));
        await sleep(500);
        if (!ok() || !D.a) return;
        at(D.a, P("pp"));
        show(D.a, true, true);
        light("pp-db", 900);
        setPaint(known(1, ["pp-db"], ["pp"]));
        await fly(D.a, [P("pp"), P("db")], 900);
        if (!ok()) return;
        light("db-sh", 900);
        setPaint(known(2, ["pp-db", "db-sh"], ["db"]));
        await fly(D.a, [P("db"), P("sh")], 900);
        if (!ok()) return;
        show(D.a, false, true);
        setPaint(known(3, ["pp-db", "db-sh"], ["sh"]));
        await sleep(650);
        if (!ok()) return;
        setPaint(target);
        return;
      }

      // chapter 4: the event forks into the good build and the bad build
      if (effChapter === 4 && target.mode === "fork") {
        const F = (k: StopKey) => pos("fork", k);
        const route = (k: StopKey): Pt[] => [F("db"), { x: 38, y: F("db").y }, { x: 38, y: F(k).y }, F(k)];
        const bare: StripScene = { ...target, lit: [], stops: { ...target.stops } };
        for (const k of ["sh", "shB", "bk", "bkB"] as const) bare.stops[k] = { ...target.stops[k], mark: "ghost", value: "" };
        setPaint(bare);
        await sleep(800);
        if (!ok() || !D.a || !D.b) return;
        for (const d of [D.a, D.b]) {
          at(d, F("db"));
          show(d, true, true);
        }
        light("db-A", 750);
        light("db-B", 750);
        setPaint({ ...bare, lit: ["db-A", "db-B"] });
        await Promise.all([fly(D.a, route("sh"), 750), fly(D.b, route("shB"), 750)]);
        if (!ok()) return;
        const built: StripScene = { ...bare, lit: ["db-A", "db-B"], stops: { ...bare.stops, sh: target.stops.sh, shB: target.stops.shB } };
        setPaint(built);
        await sleep(450);
        if (!ok()) return;
        light("A-K", 650);
        light("B-K", 650);
        setPaint({ ...built, lit: [...FORK_LINKS] });
        await Promise.all([fly(D.a, [F("sh"), F("bk")], 650), fly(D.b, [F("shB"), F("bkB")], 650)]);
        if (!ok()) return;
        show(D.a, false, true);
        show(D.b, false, true);
        setPaint(target);
        return;
      }

      // Ring again: each phase of the script moves the message one step
      if (effChapter === 6 && D.a) {
        const P = (k: StopKey) => pos("path", k);
        const d = D.a;
        const text = d.querySelector("text");
        const inRoad = (lit: string[]): StripScene => ({ ...target, lit });
        if (ring.phase === "ask") {
          setPaint(inRoad([]));
          if (text) text.textContent = "0.0s";
          at(d, P("db"));
          show(d, true, false);
          await fly(d, [P("db"), P("pp")], 400, "ease-out");
          return;
        }
        if (ring.phase === "sent") {
          const a = P("pp").x;
          const b = P("db").x;
          const c = P("sh").x;
          const total = Math.max(ring.travel.ms, 300);
          at(d, P("pp"));
          if (ring.travel.to === "half") {
            const mid = { x: (P("pp").x + P("db").x) / 2, y: P("pp").y };
            show(d, true, true);
            light("pp-db", total * 2);
            setPaint(inRoad(["pp-db"]));
            await fly(d, [P("pp"), mid], total);
            if (!ok()) return;
            show(d, false, true);
            return;
          }
          const d0 = (total * (b - a)) / Math.max(1, c - a);
          show(d, true, false);
          light("pp-db", d0, 0);
          light("db-sh", total - d0, d0);
          setPaint(inRoad(["pp-db", "db-sh"]));
          // the seconds are counted on the message: the real arrival time of this resend, spread over the length of the flight
          const seconds = focalRing?.arrivalSeconds ?? null;
          const t0 = performance.now();
          const tick = () => {
            if (!ok() || !text) return;
            const f = Math.min(1, (performance.now() - t0) / total);
            text.textContent = seconds !== null ? `${(seconds * f).toFixed(1)}s` : "";
            if (f < 1) requestAnimationFrame(tick);
          };
          tick();
          await fly(d, [P("pp"), P("sh")], total);
          return;
        }
        if (ring.phase === "arrived") {
          const seconds = focalRing?.arrivalSeconds ?? null;
          if (text && seconds !== null) text.textContent = `${seconds.toFixed(1)}s`;
          light("sh-bk", 350);
          setPaint({ ...target, lit: [...PATH_LINKS] });
          at(d, P("sh"));
          show(d, true, false);
          await fly(d, [P("sh"), P("bk")], 350, "ease-in");
          if (!ok()) return;
          show(d, false, false);
          return;
        }
        // saved or lost: the books are what the ring left them
        hideDots();
        setPaint(target);
        return;
      }
      rest();
    })();
    return () => {
      epoch.current++;
    };
    // the picture follows the chapter it draws, the phase and the asks of the ring, and the motion preference
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, effChapter, ring.stage, ring.phase, ring.asks, motion]);

  const g = geom(paint.mode, W || 320);
  const ringing = ring.asks > 0 && ring.stage !== "idle";
  const names = (k: StopKey): string => paint.stops[k].name;

  return (
    <button className="strip" type="button" ref={ref} aria-haspopup="dialog" aria-expanded={open} aria-label={target.label} onClick={onOpen}>
      <span className={`sp-rail${settled ? " settled" : ""}`} ref={rail} data-mode={paint.mode} data-ready={W > 0 ? "" : undefined}>
        <svg className="sp-lks" aria-hidden="true" focusable="false">
          <g data-grp="p">
            {PATH_LINKS.map((id) => (
              <g key={id}>
                <path className="sp-lk base" d={geom("path", W || 320).links[id]} />
                <path className={`sp-lk lit${paint.lit.includes(id) ? " on" : ""}`} pathLength={1} d={geom("path", W || 320).links[id]} style={{ "--d": `${anim[id]?.d ?? 350}ms`, "--dl": `${anim[id]?.dl ?? 0}ms` } as React.CSSProperties} />
              </g>
            ))}
          </g>
          <g data-grp="f">
            {FORK_LINKS.map((id) => (
              <g key={id}>
                <path className="sp-lk base" d={geom("fork", W || 320).links[id]} />
                <path className={`sp-lk lit${paint.lit.includes(id) ? " on" : ""}`} pathLength={1} d={geom("fork", W || 320).links[id]} style={{ "--d": `${anim[id]?.d ?? 350}ms`, "--dl": `${anim[id]?.dl ?? 0}ms` } as React.CSSProperties} />
              </g>
            ))}
          </g>
        </svg>
        {STOP_KEYS.map((k) => {
          const stop = paint.stops[k];
          const place = g.stops[k];
          return (
            <span key={k} className={`sp-stop${stop.shown && place.on ? "" : " off"}${stop.active ? " is-active" : ""}${k === "db" && ringing ? " ringing" : ""}`} data-k={k} style={{ "--x": `${place.x}px`, "--y": `${place.y}px` } as React.CSSProperties}>
              <Mark kind={stop.mark} rings={k === "db"} ringKey={ring.asks} />
              {(["u", "s"] as const).map((side) => (
                <span key={side} className={`sp-tx ${side}`}>
                  <span className="sp-nm">
                    <span className="h">
                      <Swap text={names(k)} motion={motion} />
                    </span>
                  </span>
                  <span className={`sp-vl${TIME.test(stop.value) ? " t" : ""}`}>
                    <Swap text={stop.value} motion={motion} />
                  </span>
                </span>
              ))}
            </span>
          );
        })}
        {(["a", "b"] as const).map((k) => (
          <span key={k} className="sp-dot sm" aria-hidden="true" ref={(el) => void (dots.current[k] = el)}>
            <svg viewBox="0 0 40 40">
              <circle cx="20" cy="20" r="18.5" className="sp-dot-disc" />
              <text className="sp-dot-t" x="20" y="24.4" textAnchor="middle" />
            </svg>
          </span>
        ))}
      </span>
      <svg className="sp-chev" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
        <path d="M8 17.5l6-6 6 6" />
      </svg>
    </button>
  );
}
