// The phone's path strip: the four stops of the delivery path (PayPal, Doorbell, your shop, your books) pinned to the top of the screen, with a few
// characters under each. This is what the strip shows at rest for a chapter and a ring state; the screen (app/_components/path-strip.tsx) adds the
// motion on top (the message travelling, the fork, the ring). Everything here is read from the same Panel the desktop's sticky panel draws, by the
// same tokens: the mark of a stop is markOf() of the station, and the words under it are Station.glance (lib/ui/story.ts), never typed here.
//
// Chapters the strip does not have its own picture for take the picture of the one before: the certificate shows where Ring again left things,
// and the replay of a gap that has no replay (the AI proved no cause) keeps the picture of the chapter before it.
import type { RingView } from "./ring.ts";
import { codesGlance, markOf, type ChapterNo, type MarkKind, type Panel, type Phase, type StationKey } from "./story.ts";

export type StopKey = "pp" | "db" | "sh" | "bk" | "shB" | "bkB";
export const STOP_KEYS: readonly StopKey[] = ["pp", "db", "sh", "bk", "shB", "bkB"];
export const PATH_LINKS = ["pp-db", "db-sh", "sh-bk"] as const;
export const FORK_LINKS = ["db-A", "db-B", "A-K", "B-K"] as const;

export interface StripStop {
  key: StopKey;
  name: string;
  value: string; // what is under the stop
  mark: MarkKind;
  active: boolean; // the stop this chapter is about: its name wears the highlighter
  shown: boolean;
}
export interface StripScene {
  mode: "path" | "fork";
  stops: Record<StopKey, StripStop>;
  lit: string[]; // the links that are filled in
  label: string; // what a screen reader says for the whole strip
}

const STATION: Record<"pp" | "db" | "sh" | "bk", StationKey> = { pp: "paypal", db: "doorbell", sh: "shop", bk: "books" };

// The stop a chapter is about, and in Ring again the one the message has reached.
const ACTIVE: Record<string, StopKey[]> = { "1": ["pp", "bk"], "2": ["bk"], "3": ["sh"], "5": ["sh"], "6:idle": ["db"], "6:ask": ["db"], "6:sent": ["pp"], "6:arrived": ["sh"], "6:saved": ["bk"], "6:lost": ["sh"] };

// The chapter whose picture the strip draws, and the ring phase it draws it in. While Ring again runs it is always the ring's picture, wherever the reader
// has scrolled: the message is on its way, and the strip is where it can be seen.
export function stripView(panel: Panel, chapter: ChapterNo, ring: RingView): { ch: ChapterNo; phase: Phase } {
  const ch: ChapterNo = ring.stage === "running" || chapter === 7 ? 6 : chapter === 4 && !panel.replay ? 3 : chapter;
  return { ch, phase: ch === 6 ? ring.phase : "idle" };
}

export function stripScene(panel: Panel, chapter: ChapterNo, ring: RingView): StripScene {
  const { ch, phase } = stripView(panel, chapter, ring);
  if (ch === 4 && panel.replay) return forkScene(panel);

  const token = ch === 6 ? `6:${phase}` : String(ch);
  const stops = {} as Record<StopKey, StripStop>;
  for (const k of STOP_KEYS) stops[k] = { key: k, name: "", value: "", mark: "ghost", active: false, shown: false };
  for (const k of ["pp", "db", "sh", "bk"] as const) {
    const st = panel.stations.find((s) => s.key === STATION[k]);
    if (!st) continue;
    // a resend that is on its way has not reached the shop yet: the shop waits (the path panel's mark for it is the last time's, a cross)
    const waiting = k === "sh" && ch === 6 && (phase === "ask" || phase === "sent");
    stops[k] = { key: k, name: st.name, value: st.glance[token] ?? st.glance[String(ch)] ?? "", mark: waiting ? "wait" : markOf(st, ch, phase), active: (ACTIVE[token] ?? []).includes(k), shown: true };
  }
  const reach = panel.reach ?? 2; // [Track UI-B] a message that was never sent crossed no link: a dispute nobody was listening for lights none
  const lit = ch === 6 ? (ring.stage === "done" && ring.phase === "saved" ? PATH_LINKS : PATH_LINKS.slice(0, reach)) : ch === 1 ? [] : PATH_LINKS.slice(0, reach);
  // the certificate before the ring has run draws the road as the ring chapter does at rest, and names no stop
  if (chapter === 7 && ring.stage === "idle") for (const k of STOP_KEYS) stops[k].active = false;
  return { mode: "path", stops, lit: [...lit], label: pathLabel(panel, stops) };
}

function forkScene(panel: Panel): StripScene {
  const r = panel.replay!;
  const stop = (k: StopKey, name: string, value: string, mark: MarkKind, shown = true): StripStop => ({ key: k, name, value, mark, active: false, shown });
  const stops: Record<StopKey, StripStop> = {
    pp: stop("pp", "", "", "ghost", false),
    db: stop("db", "Replay", "", "ink"),
    sh: stop("sh", r.good.name, codesGlance(r.good.statuses), "ink"),
    shB: stop("shB", r.bad.name, codesGlance(r.bad.statuses), "ink"),
    bk: stop("bk", "Your books", r.good.booksShort, r.good.ok ? "ok" : "bad"),
    bkB: stop("bkB", "Your books", r.bad.booksShort, r.bad.ok ? "ok" : "bad"),
  };
  const said = (b: ReplayBuild): string => `${b.name} answers ${b.statuses.length > 0 ? b.statuses.join(", ") : "nothing"} and the books say ${b.booksShort}`;
  return { mode: "fork", stops, lit: [...FORK_LINKS], label: `Replay: the same messages sent to the good build and the bad build. ${said(r.good)}. ${said(r.bad)}. Open the full path.` };
}

type ReplayBuild = NonNullable<Panel["replay"]>["good"];

function pathLabel(panel: Panel, stops: Record<StopKey, StripStop>): string {
  const parts = (["pp", "db", "sh", "bk"] as const).map((k) => `${stops[k].name}${stops[k].value ? ` ${stops[k].value}` : ""}`);
  return `Delivery path${panel.subject ? ` for ${panel.subject.label.toLowerCase()}` : ""}: ${parts.join(", ")}. Open the full path.`;
}
