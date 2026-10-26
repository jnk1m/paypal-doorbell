// The quiet states of the screens, as plain lines with a mark: no orders yet, the witness silent, loading, working, an error, the live lane not
// available. A heading that says what is missing, a sentence of next step, no blame, no exclamation marks. No box: the mark carries the state.
import { Mark } from "./marks.tsx";

export function Quiet({ kind = "wait", title, children }: { kind?: "ghost" | "wait" | "bad"; title: string; children?: React.ReactNode }) {
  return (
    <div className="quiet" role="status">
      <Mark kind={kind} />
      <div>
        <p className="q-title">{title}</p>
        {children ? <p className="small">{children}</p> : null}
      </div>
    </div>
  );
}
