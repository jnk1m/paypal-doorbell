// The patch Claude proposed for the cited lines, and the proof around it (lib/ui/story.ts FixProof). It is shown in chapter 5, after the sentence that
// says fixing the code does not rewrite the books: as a labelled diff, only because every check and control passed, with what the patch leaves behind
// and what the demo really deployed said next to it.
//   FixDiff          the diff, a filled block; a long line scrolls inside it, and on a phone so does a tall one. A cited line wears the highlighter.
//   FixCaption       "Proposed by Claude", and that it is not deployed in this demo
//   FixDetails       the code checks, the replay controls, the signature-check comparison, the leftovers, what was deployed, where it comes from
//   FixProofBlock    the wide layout's block: what stands behind it, the diff, the verdict, the details
// The phone's chapter puts the diff and the verdict in the chapter and the details in its "More" (phone-story.tsx).
import { Fragment, useEffect, useRef } from "react";
import type { FixDiffLine, FixProof } from "../../lib/ui/story.ts";
import { Mark, Tick } from "./marks.tsx";
import { cited } from "./path-panel.tsx";
import { RichText } from "./rich-text.tsx";

const SIGN = { add: "+", del: "−", ctx: "" } as const;
const SIGN_LABEL = { add: "added", del: "removed", ctx: "unchanged" } as const;

function FixLine({ l }: { l: FixDiffLine }) {
  return (
    <p className={`fx-l ${l.kind}${l.cited ? " hit" : ""}`}>
      {/* the sign is drawn by the stylesheet (data-s), so that it is not one more piece of text in the mono face; its meaning is the label */}
      {l.kind === "ctx" ? <span className="sg" aria-hidden="true" /> : <span className="sg" role="img" aria-label={SIGN_LABEL[l.kind]} data-s={SIGN[l.kind]} />}
      <code>{l.text === "" ? " " : cited(l.text, l.cited)}</code>
    </p>
  );
}

export function FixDiff({ proof }: { proof: FixProof }) {
  const box = useRef<HTMLDivElement>(null);
  // On a phone the block is as tall as the screen allows and scrolls inside: it opens on the first cited line, not on the file's header.
  useEffect(() => {
    const el = box.current;
    const hit = el?.querySelector<HTMLElement>(".fx-l.hit");
    if (!el || !hit || el.scrollHeight <= el.clientHeight) return;
    const at = hit.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    el.scrollTop = Math.max(0, at - el.clientHeight / 3);
  }, []);
  return (
    <div className="fx-code cited-on" ref={box} tabIndex={0} role="region" aria-label="The patch Claude proposed, as a diff. It scrolls when a line is long.">
      <div className="fx-cb">
        {proof.hunks.map((h, hi) => (
          <Fragment key={hi}>
            {hi > 0 ? (
              <p className="fx-skip">
                <span aria-hidden="true">{"⋯"}</span>
                <span className="sr">lines of the file that the patch does not change</span>
              </p>
            ) : null}
            {h.map((l, i) => (
              <FixLine key={i} l={l} />
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function FixCaption({ proof }: { proof: FixProof }) {
  return (
    <p className="fx-cap">
      <b>{proof.proposed}</b>
      {` · ${proof.note}`}
    </p>
  );
}

// The verdict: one sentence, with a mark that says it passed. It never says the patch is correct: it says what it was compared with, and on how many inputs.
export function FixVerdict({ proof, note = false }: { proof: FixProof; note?: boolean }) {
  return (
    <p className="fx-v">
      <Mark kind="ok" />
      <span>
        <span className="r1">
          <RichText r={proof.verdict} />
        </span>
        {note ? <span className="r2">{proof.verdictNote}</span> : null}
      </span>
    </p>
  );
}

export function FixDetails({ proof, noteInDetails = false }: { proof: FixProof; noteInDetails?: boolean }) {
  return (
    <>
      {noteInDetails ? <p>{proof.verdictNote}</p> : null}
      <h3 className="fx-h">What the code checked</h3>
      <ul className="list ticks fx-list">
        {proof.checks.map((c, i) => (
          <li key={i}>
            <Tick done={c.done} />
            <RichText r={c.rich} />
          </li>
        ))}
      </ul>
      <h3 className="fx-h">What the replay compared</h3>
      <ul className="list ticks fx-list">
        {proof.controls.map((c, i) => (
          <li key={i}>
            <Tick done={c.done} />
            <RichText r={c.rich} /> <span className="fx-n">{`(${c.n})`}</span>
          </li>
        ))}
      </ul>
      {proof.baseline ? (
        <p>
          <RichText r={proof.baseline} />
        </p>
      ) : null}
      <p>
        <RichText r={proof.leftovers} />
      </p>
      <p>
        <RichText r={proof.deployed} />
      </p>
      <p className="fx-basis">{proof.basis}</p>
    </>
  );
}

// The wide layout: under the three paragraphs of chapter 5, in the left column.
export function FixProofBlock({ proof }: { proof: FixProof }) {
  return (
    <div className="fx">
      <p className="fx-lede">
        <RichText r={proof.lede} />
      </p>
      <div className="fx-fig">
        <FixCaption proof={proof} />
        <FixDiff proof={proof} />
        {proof.legend ? <p className="fx-legend">{proof.legend}</p> : null}
      </div>
      <FixVerdict proof={proof} note />
      <FixDetails proof={proof} />
    </div>
  );
}
