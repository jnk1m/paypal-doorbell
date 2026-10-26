# After the S5 redesign: before and after, measured

Date of the measurement: 2026-10-19 and 2026-10-20 (UTC). What was built: the "P3 Storyline" prototype ported into the app (`docs/design/s5-ui.md`). What was measured against: the rules of `tells.md` section (c) and the targets the owner set for this step.

## How it was measured

- **Page totals**: `design-research/tools/measure.mjs <url> <width> <out.json>` against `next start` on localhost (production build), at 1440 and 390 px, for `/` in each of the three scenarios, `/live` (the unavailable state: the local server has no PayPal keys, so the probe gets a 500 and the lane falls back to the recorded run), and `/certificate`.
- **Per 900 px slice**: `slices.mjs` (in this folder) slides a viewport down the page in steps of 150 px and reports the worst case of each rule in any one viewport: bordered or filled containers (the same definition as `measure.mjs`, which counts buttons and inputs too), pills, texts above 28 px, nesting, share of red and green pixels in a screenshot, tracked or all-caps text, sentences of five or more words that are printed twice. Elements that are collapsed, transparent or clipped do not count. It was run on each scenario before Ring again and after it (the green end state), on `/live`, `/certificate`, and on the open live lane against a mocked API (the deployed shop is not reachable from this machine; the mocked answers are the recording's own snapshots).
- Run states: the live lane open (token form; after a refund; after the ring) was measured at both widths with the mock.

## Before and after

Before = the skeleton (home page, 1440 px; from `tells.md` and `design-research/tools/m-home-*.json`, `m-cert-1440.json`). After = this branch.

| Measure (target) | Before | After |
|---|---|---|
| Containers in any 900 px slice (at most 3) | 22 in the first viewport, 71 on the page | **3** at 1440 and at 390 in every scenario (the panel, the Ring again button and the select at 1440; two inline panels and the button at 390, where the select is a plain line with a chevron). 2 after Ring again. 1 on `/certificate`. The open live lane: 1 to 2. |
| Nesting | 2 to 3 deep | **0** |
| Pills in 900 px (at most 1) | 22 on the page | **0** |
| All-caps or tracked labels (0) | 56 and 32 | **0 and 0** |
| Status tint (under 2 % of any viewport) | 15.4 % at 1440, 18.7 % at 390 (red tinted panels) | red and green pixels, marks and words only: at most **0.81 %** of a viewport; light tints (a tinted background) at most **0.07 %** |
| Texts above 28 px in one viewport (one) | not controlled | **1** everywhere (a chapter is 100 vh + 160 px tall and its text starts at the same height, so two headlines are never on screen together; the headline of the first chapter is the only text above 28 px at 390, the other chapter headlines are 28 px) |
| Weights (400 and 600 only; 600 at most 15 %) | 400:59, 500:37, 700:90 (48 % at 700) | 400 and 600 only. 600 is **7.9 to 8.1 %** of the text elements at 1440, **5.4 to 5.6 %** at 390, 14.3 % on `/certificate` (14 text elements, two of them the wordmark and the headline). The prototype had 21 %. |
| Font sizes (at most 6) | 9 | **6** (12, 14, 17, 20, 40, 52 at 1440; 12, 14, 17, 20, 28, 34 at 390), at most 5 in one viewport |
| Figures tabular or mono | 28 of 80 | **all**: 69 of 69 to 75 of 75 at 1440, 111 of 111 to 117 of 117 at 390 |
| First heading from the top | 113 px (1440), 245 px (390) | **106 px** (1440), **115 px** (390); 111 and 131 px on `/live` with its notice line; 104 and 131 on `/certificate` |
| Horizontal scroll at 390 | none | **none** (every page) |
| Sentences of five words or more printed twice in one viewport | many ("$96.00" x5, "not in books" x4, "Your handler said OK, but the books did not change" x4) | **0**, in all states |
| Empty area under the left column, first screen at 1440 | about 300 px under both columns (prototype) | the left column ends at 758 to 787 px of 900, the panel at 828 px; the first chapter's text is set at the lead size so that the first screen is full |
| Page height at 1440 | 3383 px | about 7800 to 7900 px (seven chapters of scroll) |
| Fonts | system stacks | Bricolage Grotesque (display and text, optical size axis) and DM Mono (ids, times, code only), through `next/font/google`, self-hosted at build |

The status mark colors are navy (a hop that worked), red (a hop that went wrong) and a dotted or ringed shape for the rest. **Green appears only when the certificate says green**: the story view sets `data-cert="green"` when the ring is done and the certificate at the end of the run is green (scenarios 1 and 2); in scenario 3 the end of the run is red (one row stays a gap) and the page never turns green.

## What the tests hold (the rules that are not a pixel count)

`lib/ui/contrast.test.ts` (text 4.5:1, marks 3:1, green only behind `[data-cert="green"]`, no color, size, radius or shadow literal in `globals.css`, two weights, six sizes, no tracked capitals, no decoration, no ambient motion), `lib/ui/copy.test.ts` (the forbidden words on every screen, the honesty sentence, the recording date, "planted by us" by each planted bug, green only for a green certificate, no sentence twice in one chapter), `lib/ui/glossary.test.ts` (ten words, each explained once at its first occurrence, in both layouts and in the live lane), `lib/ui/story.test.ts` and `lib/ui/render.test.ts` (every chapter from the recorded snapshots, no free text from a snapshot reaches the page, the ring from the heal data and its end state, "Resend accepted, not delivered" for the row that stays a gap, no network call, `/stamp` to `/live`, no component without a user).

## What bent

- **Two sticky elements at 1440** (the top bar and the panel), where `tells.md` rule 8 asks for at most one. The product rule that the honesty sentence is always visible wins: the bar sticks. Its white backdrop is a pseudo-element, so no box shows.
- **The select on a phone has no box.** At 390 two panels can be in one 900 px slice with the Ring again button, so a boxed select would make four containers. It is a line of text with its chevron there (it keeps its border at 1440).
- **The yellow button on white is 1.54:1** at its edge. Its label is 10.3:1 (ink on yellow). The brief's palette has one yellow; the button is identified by its label, not by its edge.
- **Per-slice 600 share** at 390 reaches 16 to 23 % in a single viewport (few text elements fit on a phone screen); the page total is under 6 %. The rule is read as a page rule.
- **Identical rows**: the ledger in the panel and the list of all captures show "#2 Gift set: three coffees and a mug" at the same time at the end of the page. They are data rows, not sentences, and the slice check leaves strings that start with an order number out.
- **The ledger is not in the first chapter's inline panel** (a phone), only in the sticky one: the word "gap" would come before the text that explains it.
- `/dev/states` is a specimen sheet: it holds up to 11 panels and is not held to the container budget.
