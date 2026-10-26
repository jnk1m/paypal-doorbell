"use client";
// One glossary word with its one-line explanation (plan 10.1 #10). A button, so that the keyboard reaches it: Enter or Space opens the
// line, Escape closes it, and it also opens on hover and focus. The line stays open while the pointer is over it (WCAG 1.4.13) and is moved
// back inside the screen if the word sits near an edge.
import { useId, useLayoutEffect, useRef, useState } from "react";
import { TERMS, type TermId } from "../../lib/ui/glossary.ts";

export function Glossary({ id, children }: { id: TermId; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const tip = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = tip.current;
    if (!open || !el) return;
    el.style.transform = "";
    const r = el.getBoundingClientRect();
    const margin = 8;
    let dx = 0;
    if (r.right > window.innerWidth - margin) dx = window.innerWidth - margin - r.right;
    if (r.left + dx < margin) dx = margin - r.left;
    if (dx !== 0) el.style.transform = `translateX(${Math.round(dx)}px)`;
  }, [open]);

  return (
    <span className="term" data-term={id} data-open={open} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="term-btn"
        aria-describedby={tipId}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        {children}
      </button>
      <span role="tooltip" id={tipId} ref={tip} className="term-tip" hidden={!open}>
        {TERMS[id].tip}
      </span>
    </span>
  );
}
