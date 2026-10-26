// Helpers for the screen tests: render a screen to static HTML, and read the text a person would read from it. Offline; no browser.
import { createElement } from "react";
import type { CauseResult } from "../cause/cause.ts";
import { confirmationOf } from "../cause/confirm.ts";
import type { ReplayResult } from "../cause/replay.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveLane } from "../../app/_components/live-lane.tsx";
import { StoryView } from "../../app/_components/story-view.tsx";
import type { LiveSeed } from "./live.ts";
import type { RingView } from "./ring.ts";
import { SCENARIOS } from "./source.ts";
import { buildStory, type Story } from "./story.ts";
import type { Layout } from "../../app/_components/use-env.ts";

// The landing as it renders for one story: the wide layout (the sticky panel after the chapters) or the narrow one (a panel inside each chapter).
export function renderStory(stories: Story[], start: number, layout: Exclude<Layout, "both"> = "wide", ring?: RingView): string {
  return renderToStaticMarkup(createElement(StoryView, { stories, start, layout, ...(ring ? { ring } : {}) }));
}

// The live lane's first paint (nothing has answered yet), in one layout.
export function renderLive(stories: Story[], layout: Exclude<Layout, "both"> = "wide"): string {
  return renderToStaticMarkup(createElement(LiveLane, { stories, layout }));
}

// The live lane in a state given from outside (a seed): the snapshots it holds, the request in flight, the note beside a control. It makes no request.
export function renderLiveSeeded(stories: Story[], seed: LiveSeed, layout: Exclude<Layout, "both"> = "wide"): string {
  return renderToStaticMarkup(createElement(LiveLane, { stories, layout, seed }));
}

// One cause, with its replay, as the story prints it: the first recorded incident with its cause replaced by this one. For the tests that
// check what a cause may and may not put on the screen (no model text, the diff line as it is, the replay verdict in fixed words).
export function renderCause(cause: CauseResult, replay?: ReplayResult | null): string {
  const before = structuredClone(SCENARIOS[0].steps[0]);
  const first = before.causes[0];
  before.causes = [{ captureId: first.captureId, mode: first.mode, cause, replay: replay ?? null, confirmation: cause.status === "proposed" ? confirmationOf(cause, replay ?? undefined) : null }];
  const story = buildStory({ id: "cause-test", label: "cause test", before, fixed: null, after: null, mode: "script" });
  return renderToStaticMarkup(createElement(StoryView, { stories: [story], start: 0, layout: "wide" }));
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'", "&nbsp;": " " };
const decode = (s: string): string => s.replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);

// The words on the page in reading order. For each character: was it inside a glossary word that carries an explanation? The tooltip
// lines themselves are removed first, because they are not on the page until someone asks for them.
export function readable(html: string): { text: string; explained: boolean[] } {
  let h = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "");
  h = h.replace(/<(\w+) class="sr"[^>]*>[\s\S]*?<\/\1>/g, "");
  h = h.replace(/<span class="term"[^>]*><button[^>]*>([\s\S]*?)<\/button><span role="tooltip"[^>]*>[\s\S]*?<\/span><\/span>/g, (_m, label: string) => `⟦${label}⟧`);
  h = h.replace(/<[^>]+>/g, " ");
  const raw = decode(h).replace(/\s+/g, " ");
  let text = "";
  const explained: boolean[] = [];
  let inside = false;
  for (const ch of raw) {
    if (ch === "⟦") inside = true;
    else if (ch === "⟧") inside = false;
    else {
      text += ch;
      explained.push(inside);
    }
  }
  return { text, explained };
}

// All the text of a page, tooltips included: for the checks on what the copy says.
export function allText(html: string): string {
  return decode(html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
}
