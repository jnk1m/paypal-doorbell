// The marks of the path: one SVG per station, five shapes (an empty dotted ring, a navy dot, a check, a cross, a ring with a dot), of which the
// CSS shows the one named by data-m. Every state is a shape first, so color is never the only signal (WCAG 1.4.1). The check takes the
// certificate's color: navy until the certificate says green (--ok, app/tokens.css).

export function Mark({ kind, rings = false, ringKey }: { kind: "ghost" | "ink" | "ok" | "bad" | "wait"; rings?: boolean; ringKey?: number }) {
  return (
    <svg className="mk" viewBox="0 0 28 28" data-m={kind} aria-hidden="true" focusable="false">
      {rings ? (
        <g className="rings" key={ringKey}>
          <circle cx="14" cy="14" r="11" />
          <circle cx="14" cy="14" r="11" />
          <circle cx="14" cy="14" r="11" />
        </g>
      ) : null}
      <g className="g-ghost">
        <circle className="c-ghost" cx="14" cy="14" r="11" />
      </g>
      <g className="g-ink">
        <circle className="c-ink" cx="14" cy="14" r="11" />
        <circle className="c-dot" cx="14" cy="14" r="3.2" />
      </g>
      <g className="g-ok">
        <circle className="c-ok" cx="14" cy="14" r="11" />
        <path className="c-glyph" d="M9 14.4l3.6 3.4L19.2 10.6" />
      </g>
      <g className="g-bad">
        <circle className="c-bad" cx="14" cy="14" r="11" />
        <path className="c-glyph" d="M10 10l8 8M18 10l-8 8" />
      </g>
      <g className="g-wait">
        <circle className="c-wait" cx="14" cy="14" r="10" />
        <circle className="c-wait-dot" cx="14" cy="14" r="3.2" />
      </g>
    </svg>
  );
}

// The small mark of a list line: a check for what was done, a ring with a dot for what is still open.
export function Tick({ done }: { done: boolean }) {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      {done ? (
        <>
          <circle className="c-ok" cx="9" cy="9" r="8" />
          <path className="c-glyph" d="M5.4 9.2l2.4 2.3 4.8-4.8" style={{ strokeWidth: 1.8 }} />
        </>
      ) : (
        <>
          <circle className="c-wait" cx="9" cy="9" r="7" style={{ strokeWidth: 1.8 }} />
          <circle className="c-wait-dot" cx="9" cy="9" r="2" />
        </>
      )}
    </svg>
  );
}

export function BrandMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect className="brand-body" x="4.5" y="1.5" width="15" height="21" rx="5" />
      <circle className="brand-dot" cx="12" cy="12" r="4.6" />
    </svg>
  );
}
