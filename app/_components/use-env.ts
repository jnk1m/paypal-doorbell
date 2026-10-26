"use client";
// What the browser says about the screen: is it wide enough for the sticky panel, and does the reader want no motion. Both start at a value
// that matches the server's first paint (both layouts present, motion allowed) and are corrected once, after the page is up.
import { useEffect, useState } from "react";

export type Layout = "both" | "wide" | "narrow";

const WIDE = "(min-width: 1100px)";
const REDUCED = "(prefers-reduced-motion: reduce)";

// `forced` is for tests and the gallery: they render one layout and do not listen.
export function useLayout(forced?: Layout): Layout {
  const [layout, setLayout] = useState<Layout>(forced ?? "both");
  useEffect(() => {
    if (forced) return;
    const q = window.matchMedia(WIDE);
    const set = () => setLayout(q.matches ? "wide" : "narrow");
    set();
    q.addEventListener("change", set);
    return () => q.removeEventListener("change", set);
  }, [forced]);
  return layout;
}

export function useMotion(): boolean {
  const [motion, setMotion] = useState(true);
  useEffect(() => {
    const q = window.matchMedia(REDUCED);
    const set = () => setMotion(!q.matches);
    set();
    q.addEventListener("change", set);
    return () => q.removeEventListener("change", set);
  }, []);
  return motion;
}
