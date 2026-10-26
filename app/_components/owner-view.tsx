// The owner view (plan 5.5, video 2:10): one printable page for the shop owner, in plain sentences, no jargon. The sentences come from the
// certificate (lib/cert, fixed templates and this run's numbers); this component adds the frame: when, what kind of run, and that it is not
// signed. The top bar is not printed, so the honesty sentence is printed in the sheet itself.
import type { RunSnapshot } from "../../lib/run/snapshot.ts";
import { HONESTY, NOT_SIGNED, OWNER_INTRO, OWNER_TITLE } from "../../lib/ui/copy.ts";
import { utcDateTime, utcStamp } from "../../lib/ui/format.ts";
import { PrintButton } from "./print-button.tsx";

export function OwnerView({ snapshot }: { snapshot: RunSnapshot }) {
  const c = snapshot.certificate;
  const kind = snapshot.mode === "LIVE" ? "Live run" : `${snapshot.mode === "CASE FILE" ? "Case file" : "Recorded run"}${snapshot.recordedAt !== null ? `, recorded ${utcDateTime(snapshot.recordedAt)}` : ""}`;
  return (
    <article className="sheet" aria-labelledby="owner-h">
      <h1 className="focal" id="owner-h">
        {OWNER_TITLE}
      </h1>
      <p className="small">
        {kind}
        {c ? `. Checked ${utcStamp(c.scopeAt)}.` : "."}
      </p>
      <p className="body">{OWNER_INTRO}</p>
      {c ? (
        <ul className="owner-lines">
          {c.ownerView.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="body">Nothing was checked yet.</p>
      )}
      {c ? null : <p className="body">{NOT_SIGNED}</p>}
      <p className="owner-honesty small">{HONESTY}</p>
      <PrintButton />
    </article>
  );
}
