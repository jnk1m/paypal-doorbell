# S5 screens: the incident story

The screens tell one incident. The left column is seven chapters, the right is ONE sticky panel that draws the path (PayPal, Doorbell, your shop, your books) and redraws for each chapter. Under 1100 px each chapter carries its own copy of the panel under its headline. The look is the "P3 Storyline" prototype, ported into `app/tokens.css` and `app/globals.css`. How the look was chosen and measured: `docs/design/research/` (`tells.md` the tells of a templated UI, `benchmark.md` the references, `after.md` the before and after numbers).

## Screens

| Route | What it is |
|---|---|
| `/` | The recorded run: three real scenarios (`refund_never_booked`, `late_payment_overwrites`, `signature_rejected`) as one story each, a select in the top bar switches between them (`?s=` in the address). Then "All captures". Makes no request. |
| `/live` | The same layout; the left column is the judge's five steps (token, order, bug, refund, run Doorbell), the sticky panel fills from the real `POST /api/shop/snapshot`. Ring again calls `POST /api/shop/ring`. If the lane is not there (404, 405, any 5xx) or paused (429, 503) it plays the recorded run with one sentence in the top bar. |
| `/certificate` | The owner view: plain sentences, printable. `?s=<scenario>&step=<n>`; default the end of the first scenario. |
| `/dev/states` | The states: marks, the path while Ring again runs, the cause in its three states, the ledger, each reason Ring again is off, each thing a resend can do, the certificate in three colors, the quiet states. |
| `/stamp` | Redirects to `/live`. |

## The seven chapters

What happened / How it travelled / Why / The replay / The fix is deployed / Ring again / Certificate. All three scenarios use them; the data decides the words.

- 1 headline from the row (PayPal says, the books say) and the kind of gap (answered 200 and not applied, a late payment that overwrote the refund, rejected with 401).
- 2 the path with real times: PayPal made the event, Doorbell heard it, the shop's tries (one 200 with its milliseconds; the arrival order of payment, refund, late payment; the tries at 0 s, +28 s, +154 s and PayPal giving up).
- 3 the lines of the diff by id, the category's fixed sentence and the two checks.
- 4 the same real events through the good and the bad build.
- 5 (the fix) closes a hole in the story: the bad build never saved, so why does Ring again change the books? The fix is deployed, the gaps are still open, only a new delivery can change them. Read from step 2 of the recording.
- 6 the REAL ring, played from the heal data of the last step (`lib/ui/ring.ts`): sends, real waits (a wait over 5 s is played as 1.3 s and the page says so), the real arrival time. Reduced motion shows the end state at once.
- 7 what the run cannot prove first, the standing limits, "not signed" last; what it did check.

## Pure logic (`lib/ui/`)

`story.ts` turns RunSnapshots into a `Story` (chapter copy) and a `Panel` (layers per station, replay, ledger). Every sentence is a template with numbers, times and ids from the snapshot, or a diff line found by its id; no model text and no PayPal text. `ring.ts` is the Ring again script. `live.ts` is the lane's client logic and turns live snapshots into the same panel (the last snapshot with a cause is kept, because the cause goes when the bug is turned off). `source.ts` is the one place that decides what plays: the REAL recording. The samples (`fixtures/samples`, `build-samples.ts`) are for the gallery and tests, imported from `samples.ts`.

## Components (`app/_components/`)

`story-view` (the page, the ring player), `path-panel` (the sticky panel and its motion), `marks`, `top-bar`, `captures-list`, `live-lane`, `owner-view`, `print-button`, `quiet`, `glossary` and `rich-text`, `site-footer`, `use-env`. A test fails if one of them has no user.

## Rules that the tests hold

- The honesty sentence is in the top bar of every screen, and the bar sticks. "Recorded run" is said with its date. "planted by us" stands next to every planted bug.
- Green exists only behind `[data-cert="green"]`, which the story view sets only when the certificate at the end of the run says green and the ring is done. Until then the check marks are navy.
- The glossary has ten words, explained at their first occurrence only. The panel uses none of them before the text has explained them, because on a phone the panel comes before the text.
- None of the forbidden words; no sentence of five words twice in one chapter.
- `app/globals.css` holds no color, font size, radius or shadow; two weights, six sizes (`lib/ui/contrast.test.ts`).
