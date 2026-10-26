// The top bar. On a wide screen it is one sticky row: the brand, one sentence (the honesty sentence with the kind of run and its date), a link
// to the other half of the product, and what the screen needs on the right (the scenario switch of the recorded run). On a phone only the
// brand and the link stick, so the bar stays one short row; the switch and the sentence come right under it and scroll away with the page, on
// the first screen. It is the same markup in both: the stylesheet decides (app/globals.css, ".bar").
import type { Rich } from "../../lib/ui/rich.ts";
import { BrandMark } from "./marks.tsx";
import { RichText } from "./rich-text.tsx";

export interface BarLink {
  href: string;
  label: string;
  className?: string;
}

export function TopBar({ bar, notice, link, children }: { bar: Rich; notice?: string; link?: BarLink; children?: React.ReactNode }) {
  return (
    <>
      <a className="skip" href="#main">
        Skip to the content
      </a>
      <header className="bar">
        <div className="bar-in">
          <div className="bar-main">
            <a className="brand" href="/" aria-label="Doorbell, home">
              <BrandMark />
              Doorbell
            </a>
            {link ? (
              <a className={`bar-link${link.className ? ` ${link.className}` : ""}`} href={link.href}>
                {link.label}
              </a>
            ) : null}
          </div>
          {children}
          <p className="mode">
            {notice ? <span className="notice">{notice}</span> : null}
            <RichText r={bar} />
          </p>
        </div>
      </header>
    </>
  );
}
