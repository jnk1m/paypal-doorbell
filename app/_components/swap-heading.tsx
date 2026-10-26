"use client";
// A headline that changes with the ring fades out and in. It reserves the height of the longest headline the chapter can show (the others sit
// in the same cell, hidden), so that the text below it does not move when the headline grows to two lines.
import { useEffect, useState } from "react";

export function SwapHeading({ text, reserve, id, motion }: { text: string; reserve: string[]; id: string; motion: boolean }) {
  const [shown, setShown] = useState(text);
  const [swap, setSwap] = useState(false);
  useEffect(() => {
    if (text === shown) return;
    if (!motion) {
      setShown(text);
      return;
    }
    setSwap(true);
    const t = setTimeout(() => {
      setShown(text);
      setSwap(false);
    }, 170);
    return () => clearTimeout(t);
  }, [text, shown, motion]);
  return (
    <h2 className={`focal reserve${swap ? " swap" : ""}`} id={id} aria-live="polite">
      <span>{shown}</span>
      {reserve
        .filter((r) => r !== shown)
        .map((r) => (
          <span className="sizer" aria-hidden="true" key={r}>
            {r}
          </span>
        ))}
    </h2>
  );
}
