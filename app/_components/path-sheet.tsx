"use client";
// The full path on a phone: a bottom sheet that the strip opens. Its content is the desktop's panel for the chapter on screen (the same PathPanel,
// the same Panel), so nothing is told twice in two ways. A dialog: the page behind it is inert and does not scroll, focus stays inside it, and
// Escape, the Close button and the dark area above it close it. The sheet stays mounted for the length of its slide down, so that it does not
// empty out while it leaves.
import { useEffect, useRef, useState } from "react";
import type { RingView } from "../../lib/ui/ring.ts";
import type { ChapterNo, Panel } from "../../lib/ui/story.ts";
import { PathPanel } from "./path-panel.tsx";

const SLIDE_MS = 350;
const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export interface PathSheetProps {
  open: boolean;
  onClose: () => void;
  panel: Panel;
  chapter: ChapterNo;
  ring: RingView;
  motion: boolean;
  green: boolean; // the certificate says green: the sheet is outside the page, so it says so itself (a check is navy until then)
}

export function PathSheet({ open, onClose, panel, chapter, ring, motion, green }: PathSheetProps) {
  const sheet = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  // mounted for as long as it is open and for the slide down that follows
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), motion ? SLIDE_MS : 0);
    return () => clearTimeout(t);
  }, [open, motion]);

  // the page behind does not scroll while the sheet is open
  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = before;
    };
  }, [open]);

  // focus goes to the Close button when it opens (once: the page re-renders while Ring again runs, and must not pull the focus back), stays inside
  // while it is open, and Escape closes it
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    sheet.current?.querySelector<HTMLElement>("[data-close]")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !sheet.current) return;
      const items = [...sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const now = document.activeElement;
      if (e.shiftKey && (now === first || !sheet.current.contains(now))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (now === last || !sheet.current.contains(now))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <div className={`p-scrim${open ? " open" : ""}`} onClick={onClose} aria-hidden="true" />
      <div className={`p-sheet${open ? " open" : ""}`} ref={sheet} role="dialog" aria-modal="true" aria-labelledby="p-sheet-h" data-cert={green ? "green" : "none"} tabIndex={-1}>
        <div className="p-sheet-top">
          <h2 id="p-sheet-h">{panel.subject ? `${panel.subject.label}, the full path` : "The full path"}</h2>
          <button className="btn-text" type="button" data-close onClick={onClose}>
            Close
          </button>
        </div>
        {mounted ? <PathPanel panel={panel} chapter={chapter} fixed ring={ring} motion={motion} /> : null}
      </div>
    </>
  );
}
