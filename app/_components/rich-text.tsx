// Prints a Rich text (lib/ui/rich.ts): plain runs, **bold** and ==highlighted== runs, and the glossary words that carry their explanation.
import { Fragment } from "react";
import type { Piece } from "../../lib/ui/glossary.ts";
import type { Rich } from "../../lib/ui/rich.ts";
import { Glossary } from "./glossary.tsx";

export function Pieces({ p }: { p: readonly Piece[] }) {
  return (
    <>
      {p.map((piece, i) =>
        typeof piece === "string" ? (
          piece
        ) : (
          <Glossary key={i} id={piece.term}>
            {piece.text}
          </Glossary>
        ),
      )}
    </>
  );
}

export function RichText({ r }: { r: Rich }) {
  return (
    <>
      {r.map((run, i) =>
        run.style === "b" ? (
          <b key={i}>
            <Pieces p={run.pieces} />
          </b>
        ) : run.style === "hl" ? (
          <mark key={i} className="hl">
            <Pieces p={run.pieces} />
          </mark>
        ) : (
          <Fragment key={i}>
            <Pieces p={run.pieces} />
          </Fragment>
        ),
      )}
    </>
  );
}
