// All captures of the run, compact, under the story: one row each, what PayPal says and what the books say. A table, because it is one:
// no boxes, no rules, only alignment and space.
import type { CaptureRow } from "../../lib/ui/story.ts";

export function CapturesList({ rows }: { rows: CaptureRow[] }) {
  return (
    <section className="all" id="captures" aria-labelledby="all-h">
      <h2 id="all-h">All captures</h2>
      <table className="all-table">
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col" className="num">
              Amount
            </th>
            <th scope="col">PayPal</th>
            <th scope="col">Books</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.n}>
              <td className="item">{`#${r.n} ${r.item}`}</td>
              <td className="num">{r.amount}</td>
              <td data-l="PayPal">{r.paypal}</td>
              <td data-l="Books">{r.books}</td>
              <td className={r.kind === "gap" ? "res-gap" : r.kind === "tied" ? "res-tied" : undefined}>{r.result}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
