// The owner view of a recorded run's certificate: one printable page in plain sentences (plan 5.5, video 2:10). It opens on the scenario named in
// the address (/certificate?s=refund_never_booked); without it, on the first. It shows the end of the run, or the step named by &step=N. A live
// session's certificate is read in the live lane. Static data only: no request leaves the server.
import type { Metadata } from "next";
import { TermPlanner } from "../../lib/ui/glossary.ts";
import { ALL_SCENARIOS, SCENARIOS } from "../../lib/ui/source.ts";
import { modeLine } from "../../lib/ui/story.ts";
import { OwnerView } from "../_components/owner-view.tsx";
import { SiteFooter } from "../_components/site-footer.tsx";
import { TopBar } from "../_components/top-bar.tsx";

export const metadata: Metadata = { title: "Owner view | Doorbell" };

export default async function CertificatePage({ searchParams }: { searchParams: Promise<{ s?: string; step?: string }> }) {
  const q = await searchParams;
  const sc = ALL_SCENARIOS.find((x) => x.id === q.s) ?? SCENARIOS[0];
  const wanted = Number(q.step);
  const index = Number.isInteger(wanted) && wanted >= 1 && wanted <= sc.steps.length ? wanted - 1 : sc.steps.length - 1;
  const snap = sc.steps[index];
  return (
    <>
      <TopBar bar={modeLine(new TermPlanner(), snap)} link={{ href: `/?s=${sc.id}`, label: "Back to the story", className: "no-print" }} />
      <main id="main">
        <OwnerView snapshot={snap} />
      </main>
      <SiteFooter live={false} />
    </>
  );
}
