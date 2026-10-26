# Why a UI reads as "LLM-built": the tells, the evidence, and an audit of Doorbell

Date 2026-10-19. Scope: product screens (a tool/dashboard like ours), not landing pages. Part 1 = evidence, Part 2 = audit of our screens, (c) = rules.

## 0. Method, limits, evidence grades

What I did: web search plus direct fetches of the primary documents; Hacker News read through the Algolia API (threads and comments); our deployed skeleton measured with a headless browser (script in `tools/`); the three mockups read as markup (they are not rendered: `support.js` is missing from the project folder, so every mockup number below is a static markup count, not a rendered measurement).

Limits, stated plainly:
- Reddit could not be read: the search tool blocks the domain and direct requests return 403. No Reddit thread is cited. Where a source relays a Reddit post it is marked second-hand.
- Most "tells" articles are blogs or tool vendors with something to sell. The only quantitative corpus is Krebs (1,590 Show HN landing pages, deterministic DOM checks, 5-10 % false positives by his own QA); it publishes tier counts, not per-pattern prevalence. A search snippet claiming "42 % of AI interfaces look identical" had no source and is not used.
- The strongest evidence is not a blog: it is Anthropic's own current `frontend-design` SKILL.md, which lists the model's default looks and tells. I fetched the raw file today.
- A skeptic on the Krebs thread (michaelcampbell) calls the colored-left-border claim "n=1 plus frequency illusion". Fair. That is why tells are scored by how many independent sources name them and by whether a script can detect them, not by one designer's quote.

Evidence grades used in the tables:
- P = primary: Krebs's scored corpus, or the model vendor's own SKILL.md / cookbook.
- M = three or more independent practitioner sources agree.
- S = one source, or a vendor selling a fix.
- J = my own judgment; no source found.

Where the look comes from (consensus of the sources; causes are asserted, not proven):
1. Statistical averaging. Models emit the high-probability centre of the training data. Anthropic's cookbook says so itself: "You tend to converge toward generic, 'on distribution' outputs... what users call the 'AI slop' aesthetic."
2. Shared substrate. Tailwind plus shadcn/ui plus Lucide icons is what most builders emit; Tailwind's `bg-indigo-500` demo color is blamed for the purple (Adam Wathan's apology, Aug 2025, relayed by two blogs). On the HN thread: "Most of these patterns come from the obsession with Tailwind" (port11).
3. Happy-path generation: one screen, no real data, no states, so every block gets the same container and the same weight.
4. Prompt-level fixes move the default instead of removing it. The cookbook itself warns "You still tend to converge on common choices (Space Grotesk, for example)". The SKILL.md now lists the "distinctive" looks as defaults too (cream plus serif plus terracotta; near-black plus acid accent; broadsheet hairlines). CodeMySpec: asking for "distinctive" yields the next common look. So the fix has to be structural (fewer containers, one hierarchy), not a new skin.
5. Consequence is real: one HN reader (DaiPlusPlus, 2026-08-05) closed the tab on "that beige colour and blurred-backdrop navbar" before reading a word, treating the look as a proxy for low effort. Judges skim; the look sets the prior.

## (a) Ranked list of tells

Ranking = number of independent sources x diagnostic strength x how fast it shows on a product screen like ours. "Detect" = something a reviewer can check on a screenshot (or count with the DOM script in `tools/measure.mjs`).

| # | Tell | Evidence (source, grade) | How to detect |
|---|---|---|---|
| 1 | Card kit: every region in a rounded box, one radius everywhere, 1 px border plus soft shadow, boxes inside boxes | Anthropic SKILL.md cluster 4: "content chopped into identical rounded cards, one border-radius on everything regardless of hierarchy, the same soft grey shadow, gradient washes" (P). Fountain Institute "cards inside cards... a filing cabinet inside a filing cabinet" (M). impeccable.style rules nested-cards, hairline-border-plus-wide-shadow, extreme radius (M). noqta "identical radius, hierarchy disappears" (M). SaaSUI "grid of equal cards flattens importance" (M). Krebs "identical feature cards" (P). HN dematz "a grid of rounded rects" (M). Counter: bobthepanda, cards are just current design-system practice. | Count boxed containers in one viewport (target: single digits). Max nesting depth. Number of distinct radii (more than 3 = drift; 1 = "one radius everywhere"). Is there any container that holds only one child? |
| 2 | Colored side or top accent bar on a card or callout | Krebs: designer quote "colored left borders are almost as reliable a sign of AI-generated design as em-dashes for text", and detector "colored borders on cards, top or left edge" (P). noqta: "the single most recognizable signature of AI-generated UI" (M). impeccable rule side-tab (M). Fountain "multicolored side tabs" (M). | Any element whose left or top border is 3 px or more and a different color from its other sides. Zero is the target. |
| 3 | Tracked, tiny, ALL-CAPS eyebrow label above headings and values | SKILL.md: "Avoid... Using all caps for labels. Adding unnecessary typographic labels above content", and cluster 5 "a tracked-out ALL-CAPS eyebrow label above every heading" (P). Krebs "all-caps headings and section labels" (P). impeccable "label above a heading" (M). noqta "auto-applied everywhere" (M). | Count text with `text-transform: uppercase` or letter-spacing above 0.04em. More than 3 per screen = tell. Ask of each: does it say anything the heading or the value does not? |
| 4 | "Template chrome": monospace for small data labels, middle-dot joined meta strings (A · B · C), arrow appended to links and buttons, tinted near-black (#111) as black, "WORD - fragment" labels | SKILL.md cluster 5, verbatim list (P). No other source lists this bundle; it is the model vendor describing its own habits. | Count the "·" separators per screen; share of text set in the mono face; any "->" or arrow glyph or icon on a link or button; sample the "black" pixel (is it #111 or similar rather than pure black or a brand ink?). |
| 5 | Pill / chip / badge proliferation (status chip soup) | Krebs "badge right above the hero H1" (P). impeccable "badge above headline", demo annotation "Status-chip soup" and "Everything equal" (M). CodeMySpec "centered hero with a pill badge" (S). LA dashboard guide "gradient on a status pill reads as marketing" (S). | Count elements with radius of at least half their height plus border or fill. Each must be a state or a control; a pill that is a tag or metadata is the tell. |
| 6 | Pastel-tinted status panels: pale background plus colored border plus same-hue text (red-50 / red-200 / red-700; also green, amber, blue) | The exact triple is not named as a tell by any source (J). Adjacent: LA "shadow, border and background tint combined on one card" (S); impeccable "side-tab... turns an ordinary card into something that looks like an alert" (M); Fountain "meaningless status dots" (S); noqta "decoration cosplaying as information" (M). It is the stock shadcn/Tailwind alert and badge recipe, so it is the default the models reproduce (J). | Sample background colors of containers: how many are a tint of the status hue? Share of the viewport covered by tint (script in `tools/rhythm.mjs`). Is the status hue also on the border and the text of the same box? |
| 7 | Default type: Inter, Geist, Space Grotesk, Instrument Serif, Roboto; one family at nearly one weight | Krebs font list: "Inter for everything"; "Space Grotesk, Instrument Serif and Geist"; serif-italic accent word (P). Cookbook: avoid "Inter, Roboto, Arial, system fonts" yet "you still converge on Space Grotesk"; the cookbook's own "Technical" pick is the IBM Plex family, i.e. today's suggested alternative is tomorrow's default (P). RP, 925, CM agree on Inter (M). Counter: DaiPlusPlus "nothing wrong with system fonts" for product UI. | Read the font names. Then check hierarchy: sizes and weights actually used. Flat = 12-17 px and weight 400 vs 700 only. |
| 8 | Palette defaults: purple/indigo gradient; near-black plus one acid or electric accent (permanent dark, medium-grey body text); warm cream plus serif plus terracotta; neon glow | SKILL.md clusters 1 and 2 (P). Krebs "VibeCode purple", "perma dark mode with medium-grey body text and all-caps labels", "large colored glows" (P). Fountain neon palettes (M). PG, RP, CM (M). HN sen "purple-on-purple-with-glowing-purple", stingraycharles "how come all LLMs converged on dark mode with purple" (M). | Dominant hue(s); count saturated accent hues on one screen (more than 2 = tell); background luminance; any gradient or glow. |
| 9 | Icon on every label; icon-in-tile; emoji bullets | Krebs "sidebar/nav with emoji icons", "icon-topped feature cards" (P). Fountain "emojis as UI elements" (M). RP emoji feature icons (M). LA "decorative emoji", "default-weight icons" (S). impeccable icon-tile-stack (M). HN dematz "each feature has a tangential emoji" (S). | Fraction of labels, headings and buttons that start with a glyph. Does the icon say anything the adjacent word does not? Emoji: grep. |
| 10 | Flat hierarchy: everything the same weight; equal cards; stat tiles; bold everywhere | SaaSUI "no focal point", "grid of equal cards" (M). impeccable "Everything equal", "Flat type hierarchy", "Hero metric layout" (M). LA dashboard "equal-3 KPI grid" (S). Fountain "nothing is emphasized when everything is emphasized" (M). Krebs "stat banner rows" (P). | Squint test: can you find the one thing that matters in 2 seconds? Count elements at weight 600+ (target under 15 % of text); count equal-sized sibling boxes (3+ identical = tell). |
| 11 | Uniform spacing with no rhythm | SaaSUI "perfectly even spacing with no rhythm" (M). braindetox, impeccable "monotonous spacing" (M). AskCodi "spacing felt random" (S). | List the vertical gaps between siblings: if section-to-section equals item-to-item, there is no grouping. |
| 12 | Gradient wash, glassmorphism, glow, pulsing "live" dot, bounce easing | Krebs gradient everything, glassmorphism, glows (P). SKILL.md "fade-and-slide-up entrances... hover transitions on every card are the generic default" (P). noqta pulsing "Live" pill (M). impeccable pulsing dot, bounce/elastic easing (M). LA "cap live indicators at 2 per viewport" (S). | Any `infinite` animation that is not a spinner for a pending request; any overshoot easing; any `backdrop-filter`, radial or linear gradient used as decoration. |
| 13 | Centered layout (hero, verdict blocks over left-aligned content) | AskCodi "centered div" (S). Krebs "centered hero" (P). RP (S). | Mixed alignment: centered block directly above or below left-aligned blocks with no reason. |
| 14 | Over-explaining and repeated copy: the same sentence in several places; hint text under controls; reassurance lines | impeccable "Redundant UX writing: four bits of text explain the same field", "same text repeated inside one container" (M). SKILL.md "Let each written element do exactly one job" (P). deslop skill listing "verbose empty states" (S, via snippet). The specific "arrow keys work" hint is my judgment (J). | Count exact repeats of any sentence of 5+ words on one screen. Cover each hint line: does the user lose the ability to act? If not, it is filler. |
| 15 | Subject-literal metaphor as decoration (stamps, receipts, tape, staples, perforation, ink texture) | No source found (J). Inference only: SKILL.md tells the model to "open with the most characteristic thing in the subject's world" and to draw on the subject's "materials and vernacular", which pushes a model toward literal props for a "verification" product. Treat as a hypothesis. | Remove the prop in your head: does any data disappear? Rotation, mix-blend-multiply, zigzag clip-path, paper textures, dashed "perforations" are decoration. |
| 16 | Stacked banners and bars before the content | No source for the pattern (J). Adjacent: SKILL.md "template chrome that appears whatever the subject"; Krebs "stat banner rows"; AskCodi "marketing hero on a dashboard". | Pixels from top of viewport to the first heading, as a share of viewport height; count of full-width bars; sticky or fixed elements. |
| 17 | Numbered markers where there is no sequence (01 / 02 / 03, 1-2-3 circles) | SKILL.md "only appropriate if the content actually is a sequence" (P). Krebs "numbered 1, 2, 3 step sequences" (P). impeccable "tiny numbered section labels" (M). | Is the number an order the user must follow? An index used as a cross-reference is borderline. |
| 18 | Happy path only; generic empty state (icon plus one line plus button) | SaaSUI "optimizes for the happy path" (M). LA dashboard guide (S). questera prompt template "illustration or icon, one-line explanation, single CTA" (S). | Is there a designed state for empty, loading, error, partial? Does the empty state name the next action specifically? |
| 19 | Proportional digits in numeric columns (no tabular numerals) | LA dashboard guide "numerals in proportional sans-serif do not align vertically" (S). | Stack two amounts or times: do the digits line up? Look for `font-variant-numeric: tabular-nums`. |
| 20 | Placeholder-grade or marketing copy ("Welcome back!", "Unlock", "Supercharge", fake round stats) | SaaSUI #6 (M). CM, LA, Fountain "Build faster. Ship smarter." (M). | Read the buttons and empty states: would the sentence fit any product? |
| 21 | Style drift: radii, grays or libraries shifting across the page | RP "drift in long sessions" (S). braindetox "coherence, not consistency" (S). HN slopinthebag on the vibe-coded Railcode site: panels "incohesive" with the rest (S). | Count distinct radii, grays, font sizes. Dozens of one-offs = drift. |

Not a tell, do not "fix": status said by icon plus word plus border style instead of color alone (our own accessibility contract; WCAG), contrast of at least 4.5:1, visible focus, 44 px targets, glossary tooltips for jargon. The HN critique of Claude-built dark sites is low contrast (vunderba), so keeping our contrast test is the opposite of a tell.

Also: a single tell proves nothing. Krebs groups sites by count: 4+ patterns = high (22 % of 1,590), 2-3 = medium (32 %), 0-1 = low (46 %). Before AI "everything looked like Bootstrap". The signal is the cluster, and it is read in seconds.

## (b) Audit: our screens against the tells

Key (full paths):
- SK = current skeleton. Screenshots: `<session scratchpad, outside the repo>/s5-shots/` (`home-1440.png`, `home-full-1440.png`, `home-390.png`, `certificate-1440.png`, `states-1440.png`, `home-dark-1440.png`, `live-1440.png`). Numbers marked "measured" come from the deployed page https://paypal-doorbell.vercel.app/ (same text and 3383 px height as `home-1440.png`) read with `tools/measure.mjs`, `tools/stack.mjs`, `tools/rhythm.mjs`, `tools/rep.mjs`. CSS in `app/globals.css` and `tokens.css`.
- A = Receipt and Stamp: `.../scratchpad/design-canvas/project/Main.dc.html`, `A-detail.dc.html`, `A-mobile.dc.html`
- B = Signal Trace (dark): `.../project/B-landing.dc.html`, `B-detail.dc.html`, `B-mobile.dc.html`
- C = Two Ledgers: `.../project/C-landing.dc.html`, `C-detail.dc.html`, `C-mobile.dc.html`
- Severity: HIGH = a reviewer names it within 5 seconds, on the first screen. MED = visible but arguable, or below the fold. LOW = minor or defensible. 0 = absent.

### Measured facts about the skeleton (home page, 1440 wide, light mode)

| Measure | Value |
|---|---|
| Boxed containers (border or fill, not inline) | 71 on the page, 22 inside the first 900 px; 72 at 390 px |
| Nesting | 3 boxes deep (gap card > node card or cause card > chip) |
| Pill-shaped elements | 22 |
| Elements with a 3 px+ left or top border | 8 flagged = 7 one-side accent bars (2 side cards, 2 gap cards, 2 callouts, 1 certificate) plus the stamp's uniform double border |
| Dashed, dotted or double borders | 8 |
| ALL-CAPS text elements / letter-spaced text elements | 56 / 32 |
| SVG icons | 28 |
| Containers filled with the red tint (#FDECEC) | 12 |
| Pixels in the first viewport that are the red tint | 15.4 % at 1440, 18.7 % at 390 |
| Text elements at weight 700 | 90 of 186 (48 %); weight 400 only 59 |
| Distinct font sizes | 9 (12 to 52 px); 169 of 186 text elements are 12-17 px |
| Fonts | system-ui 152 elements, ui-monospace 34; no `tabular-nums` anywhere in `globals.css` |
| Gap between all six top-level sections | exactly 28 px (`main { gap: 28px }`); inside each gap card every child is 16 px apart |
| Top stack before content | 93 px, 2 bars at 1440 (10 % of viewport); first heading at y = 113. At 390 px the heading starts at y = 245 of 844 (29 %) |
| Repeats on one page | "$96.00" x5, "not in books" x4, "Your handler said OK, but the books did not change" x4, "recorded" x8, "planted by us" x4, the word "gap" x13 |
| Emoji / gradients / box-shadows / infinite animations on the home page | 0 / 0 / 0 / 0 |

### Cross-direction scoreboard (H = high, M = medium, L = low, 0 = absent, ? = not measurable from markup)

| Tell | SK | A | B | C |
|---|---|---|---|---|
| 1 Card kit | H | M | H | H |
| 2 Side/top accent bar | H | 0 | 0 | 0 |
| 3 ALL-CAPS tracked eyebrows | H | H | H | H |
| 4 Template chrome (mono labels, dots, arrows, #111) | M | H | H | H |
| 5 Pills and chips | H | M | H | H |
| 6 Pastel-tint status panels | H | 0 | L | H |
| 7 Default type | M | M | M | H |
| 8 Palette default | L | L | H | M |
| 9 Icon on every label | M | L | H | H |
| 10 Flat hierarchy | H | L | M | M |
| 11 Uniform spacing | M | ? | ? | ? |
| 12 Glow, pulse, bounce | 0 | 0 | M | M |
| 13 Centered layout | M | L | 0 | L |
| 14 Over-explaining, repeats | H | M | M | M |
| 15 Literal metaphor props | L | H | L | M |
| 16 Stacked top bars | H | H | H | H |
| 21 Radius drift | M | L | M | H |

Blunt reading: the skeleton is the shadcn kit in greyscale (cards, pastel alerts, eyebrows, pills, accent bars). A removes the kit but replaces it with props. B swaps the kit for the near-black-plus-electric-accent cluster. C is the kit with nicer type. All four share the same top stack and the same cluster-5 chrome. The things that are genuinely ours, and not on any list: the one-sentence headline "PayPal refunded $48. The books still say paid. No error anywhere." (all three mockups), B's four-lane trace on one time axis, C's row-by-row ledger with a "compared by id" seam, and the content itself (specific, honest copy, designed states).

### Audit table

| Tell | Where it is in ours | Severity |
|---|---|---|
| 1 Card kit | SK `home-full-1440.png`: the Recorded-run panel holds 3 scenario pills, 3 step cards and 2 buttons; two "PAYPAL SAYS / THE BOOKS SAY" cards; each gap card holds a grey balance strip, three node cards, a callout, a cause card and a ring card; five row cards; the certificate card holds six grey KPI tiles. 71 boxes, 3 deep, 5 radii (6 / 10 / 14 / pill / circle). Worst single spot: the first gap card, y 935-1601 on the 1440 page, holds 15 boxes in 666 px (measured). One radius does everything: 47 elements share 10 px, 15 are pills, 7 circles, 5 are 6 px, 4 are 14 px. | HIGH |
| | A `Main.dc.html:155,183` two 1 px bordered gap cards, `:301` three step cells, `:314` three scenario buttons; `A-detail.dc.html:162,180,193` three more panels. Square corners and hairlines put it nearer Anthropic cluster 3 than the card kit. | MED |
| | B `B-landing.dc.html`: every section is `border:1px solid #2A3A56; radius 8px` (lines 103, 120, 224, 237, 257, 294, 311); inside the gap cards the PAYPAL SAYS / BOOKS SAY boxes (245-247, radius 6) are boxes in boxes. 18 bordered declarations; radii 4, 6, 8 nested. | HIGH |
| | C `C-landing.dc.html`: 16 px cards (110, 222, 268, 326), 12 px inset boxes inside them (282, 336), 10 px buttons, 999 px pills; 22 bordered declarations; 8 distinct radii (2, 4, 6, 8, 10, 12, 16, 999). Anthropic cluster 4 almost word for word. | HIGH |
| 2 Side/top accent bar | SK `globals.css`: `.gap` 6 px left bar (871), `.evidence` 6 px left bar (1094), `.slip` 6 px grey top bar (695), `.cert` red top bar (1334), `.owner-sheet` (1588). In `home-full-1440.png`: red stripe at the left edge of both gap cards and both red callouts, grey caps on the two side cards, red cap on the certificate. `tokens.css` defines `--accent-width: 6px /* the colored edge of a gap card */`, so this is a decision in the design system. 7 bars measured (8 flagged elements minus the stamp's uniform border). | HIGH |
| | A, B, C: none in the markup (A uses a 3 px double rule under the band, which is a rule, not a card edge). | 0 |
| 3 ALL-CAPS eyebrows | SK `globals.css:146-158`: one rule gives `text-transform: uppercase`, `letter-spacing: .06em`, bold 12 px to eight selectors (`.eyebrow`, `.slip-label`, `.compare-label`, `.row-label`, `.numbers dt`, `.build-label`, `.state-sub`, `.owner-kicker`). Visible: "RECORDED RUN", "PAYPAL SAYS", "THE BOOKS SAY", "PAYPAL / DOORBELL / YOUR HANDLER" over each node, "PAYPAL / BOOKS" over each row value, six KPI tile captions ("CAPTURES CHECKED", "COVERAGE", ...), "DOORBELL - MAPLE MUG BOOKS" on the certificate. 56 all-caps elements, 32 tracked. | HIGH |
| | A `Main.dc.html`: 16 uppercase plus 21 tracked-out (.14-.18em) labels in the landing alone ("Inspection slip - Maple Mug - Order #1042" `:77`, "What PayPal says" `:88`, "Certificate - header" `:121`, "First-run guide" `:215`, "Recorded scenarios" `:231`, "Stamp key" `:246`, plus State, Certificate scope, Mode in the band `:54-62`). Barlow Condensed uppercase headings on top (`:49`, `:147`). | HIGH |
| | B `B-landing.dc.html`: 15 tracked labels, typed in capitals ("CERTIFICATE SCOPE" 65, "RECORDED SCENARIOS - 3" 104, "DELIVERY TRACE" 123, "FIRST-RUN GUIDE" 296, "THE STAMP HAS THREE STATES" 312, lane names PAYPAL / WITNESS / YOUR HANDLER 144-156). Krebs lists "perma dark with medium-grey body text and all-caps section labels" as one pattern; B is that sentence. | HIGH |
| | C `C-landing.dc.html`: 10 uppercase labels, each with an icon in front (225-227 "STILL CANNOT PROVE" with a dashed-square icon, 237 "WHAT IT CHECKED" with a circle icon), plus "COMPARED BY ID", "PURCHASE", "AMOUNT", "STATE" in the seam column. | HIGH |
| 4 Template chrome | SK: ink is #111111 (`tokens.css --ink`; 3 filled buttons are rgb(17,17,17)), mono face for 34 small data elements, middle-dot strings everywhere ("Sandbox demo - fictional shop - PayPal test money - bugs are planted by us" in the honesty bar; "Step 1 of 3 - arrow keys work"; "Checked 5 of 5 captures (100%) - 0 too new to verify - $96.00 across 2 refunds not in books"), "Next ->" button with arrow icon, "Refund - order #2 - $48.00 - Your handler said OK..." in the gap pills. | MED |
| | A: ink #0E1A2B as the "black" (`Main.dc.html:35`), IBM Plex Mono as the small-label face (45 uses), the same dot-joined honesty string (`:40`), "Open this gap ->" (`:173`), "What it still cannot prove, printed first ->" (`:124`), back arrow (`A-detail:77`). All five items of SKILL.md cluster 5. | HIGH |
| | B: same dot string (45), "RECORDED SCENARIOS - 3", arrow icons on "Open gap 1", "Next", "Read what it cannot prove" (229-252, 298), Plex Mono on 38 elements, #0A101C / #060B14 as black. | HIGH |
| | C: Geist Mono labels (48 uses), dot strings ("Scope - as of", "RECORDED RUN - recorded Oct 19, 2026" 70), arrow icons on "Open gap" (320), #12161C as black. | HIGH |
| 5 Pills and chips | SK (measured 22): in the status band "RECORDED RUN" (bordered pill), "sample data" (dashed pill), "bug on: ack_then_drop - planted by us" (pill); the three scenario pills; the two red gap pills in the middle of the page; per gap card a numbered circle, a "planted by us ack_then_drop" pill, a code chip ACKED_BUT_NOT_APPLIED and a "final" pill; five TIED/GAP pills in Rows. The band alone has 3 metadata pills that are not states or controls. | HIGH |
| | A: the stamp is reused as a chip in the band (`Main.dc.html:55`), as the hero stamp (130), as a mini stamp in each card (157, 185) and in a key (245): the same object four times; plus boxed tags ("RECORDED RUN" 63, "ACKED_BUT_NOT_APPLIED" 162). | MED |
| | B: bordered chips for "planted by us" (241, 261), error codes (250, 280), "CERTIFICATE" (225), "RECORDED RUN" (70), numbered scenario badges (108), plus a filled coral "2 gaps" chip in the band (59). | HIGH |
| | C: 10 pill or circle radii; header "gap" pill (60), RECORDED RUN pill (68), per-card red or green pill (271-274), dashed "planted by us" chip (276), numbered circles (377-389). | HIGH |
| 6 Pastel-tint status panels | SK: `tokens.css` defines every tone as a triple (`--red-line / --red-bg / --red-ink`, same for amber and blue) and `[data-tone]` (globals.css:8-23) applies all three to whatever carries it. Result in `home-1440.png`: the entire status band is pink with a red bottom border and red text; the GAP FOUND stamp is red-50 with a double red border and 52 px red-900 text; both gap pills; both callouts; both "YOUR HANDLER" node cards. 12 containers, 15.4 % of the first viewport (18.7 % on phone) is red tint. `states-1440.png` repeats it in amber, green and blue. | HIGH |
| | A: none. Stamps are ink on transparent, multiplied onto paper; no tinted background anywhere. This is the one direction that already obeys "status color only on the mark". | 0 |
| | B: status is a filled chip (coral, amber, mint with dark text) and colored text on a dark card; panels are not tinted except the lane band. | LOW |
| | C: red-50/200/700 (#FCEEED / #EFB7B3 / #B3261E) on the header chip (60), the per-card pill (271) and the entire mismatch row of the ledger, which is a full-width red-50 band with a red-200 border (168); green-50 (#E8F5EE / #A8D8BD / #176B3A) on the tied pill and the healed callout (274, 304); amber-50 (#FFF4DC / #E6C27A / #8F5200) on the unverified callout (344). The shadcn alert palette, all three states. | HIGH |
| 7 Default type | SK: system-ui plus ui-monospace (no face chosen) with weight 700 on 48 % of text; the hierarchy is carried by weight and caps, not by scale (169 of 186 text elements are 12-17 px, one 52 px stamp). Not a "default font" tell for a tool UI by itself (DaiPlusPlus is right about system fonts), but together with caps and bold it is the flat-hierarchy tell. | MED |
| | A: Barlow Condensed uppercase display plus IBM Plex Sans/Mono. Plex is the cookbook's own suggested "Technical" family, so it is the new default; condensed all-caps headings add to tell 3. | MED |
| | B: IBM Plex Sans/Mono only (one family, 2 faces). | MED |
| | C: Geist plus Geist Mono, which Krebs lists among the "common LLM font pairings". | HIGH |
| 8 Palette | SK: neutral greys plus red-50 and blue-50; no hue defaults, but see tell 6. | LOW |
| | A: cool grey desk (#F2F4F7), navy ink, one blue accent (#1F4FD8), red/amber/green only on stamps. Restrained. | LOW |
| | B: near-black #0A101C plus electric blue #5BA8FF, orange #FF9A3C, coral #FF6B7A, mint #3DD68C and amber #FFD166: five saturated accents on a permanent dark theme with medium-grey body text (#B4C1D6, #8FA0BC). SKILL.md cluster 2 plus Krebs "perma dark". The h1 also colors one phrase ("The books still say paid." `B-landing:98`), which SKILL.md names as a default ("Accenting just a single word or phrase in a headline"). | HIGH |
| | C: stone-50 (#FAFAF9), ink #12161C, pastel red/green/amber. Warm off-white is the beige-adjacent default, but without serif or terracotta it is mild. | MED |
| 9 Icons on every label | SK (28 svg on the page): a glyph in front of every chip and state, a bell on the header and on each Ring button, an icon on each node label ("PAYPAL", "DOORBELL", "YOUR HANDLER"), arrow icon on Next. | MED |
| | A: 6 on the landing, used sparingly (bell, tick boxes). | LOW |
| | B: 22-24 svg: status gems, info icon before the honesty bar, an icon before each banner statement, heartbeat glyph. | HIGH |
| | C: 26-33 svg: an icon before the state chip, scope, mode, every eyebrow, every callout and every button. | HIGH |
| 10 Flat hierarchy | SK `home-full-1440.png`: the stamp is the only large thing, then everything is 12-17 px, bold on 48 % of text. Equal siblings: 3 step cards, 2 side cards, 3 node cards per gap (x2), 2 gap cards, 5 row cards, 6 KPI tiles. "GAP FOUND" appears as a 52 px stamp directly under a 15 px band that already says the same in red, so the focal point competes with its own copy. | HIGH |
| | A: strong focal point (a 44 px sentence headline plus the stamp), but three equal step cells and two equal gap cards below. | LOW |
| | B: the trace is a real focal object; below it, two equal cards and three equal pick buttons. | MED |
| | C: the ledger and its 40 px values lead; two equal gap cards below. | MED |
| 11 Uniform spacing | SK (measured): six top-level sections all 28 px apart, whether they are related or not (guide to verdict, strip to gaps, gaps to rows); every child of a gap card 16 px apart; card to card 20 px. Four values in total, and the between-group value (28) is barely bigger than the in-group one (16). A, B, C: not measurable from markup. | MED |
| 12 Glow, pulse, bounce | SK: none (no gradient, no shadow, no animation on the home page). | 0 |
| | B: `.hb` heartbeat glyph pulses forever in the status band (`B-landing:24-26, 83`). | MED |
| | C: the witness dot has an infinite `beat` ring (`C-landing:26, 73`); the stamp lands with overshoot easing `cubic-bezier(.2,.9,.3,1.25)` at scale 1.45 and rotate (`:24-25, 182`), which impeccable flags as bounce easing. | MED |
| 13 Centered layout | SK `home-1440.png`: the intro and guide are left-aligned, then the stamp, the "Checked 5 of 5..." line and the two red gap pills are centered, then the timelines are left-aligned again. | MED |
| 14 Over-explaining, repeats | SK (measured): the verdict is said in the band, in the stamp, in the "Checked 5 of 5" line, in two pills, in two callouts, in the certificate line and in a KPI tile; "recorded" x8 (band chip, band timestamp, panel label, panel sentence, and twice "Recorded run: plays the recorded ring"); "planted by us" x4. Filler hints: "Step 1 of 3 - arrow keys work" (`run-player.tsx:110`), "You are watching a recorded run. Nothing here calls PayPal or an AI service." directly under the label "RECORDED RUN", "Recorded run: plays the recorded ring (step 3 of 3)." twice, and a dashed empty card "Cause: No cause is shown for this gap yet." per gap. The glossary underlines (10) are fine; this is not. | HIGH |
| | A: "recorded" x8, stamp key legend plus a stamp in every place, "Planted by us - bug mode ack_then_drop" in every card (3), a caption under almost every value. | MED |
| | B: "recorded" x8-9, "planted by us" x3, legend line above the trace repeating what the dots mean. | MED |
| | C: "planted by us" x6, "recorded" x5; helper lines such as "The sentence above is from the 14:02:26 scan. Run Doorbell again to refresh it." (255) are justified. | MED |
| 15 Literal metaphor props | A: the whole direction. Rubber stamp rotated -7 deg with `mix-blend-mode: multiply` and a radial-gradient ink-dropout texture (`Main.dc.html:130-140`); a zigzag `clip-path` torn-receipt edge (`:282-288`); dashed "perforations" (24 dashed, dotted or double borders on the landing); delivery "tape" slips rotated .45 and -.3 deg (`A-detail:124,137`); a stapled note, rotated -.25 deg, with a drawn staple (`:191-193`); rotated mini stamps on every card. Every one of these removes no data if deleted. The stamp's three shapes (rect double / dashed pill / circle) do carry state; keep that, drop the paper. | HIGH |
| | SK: the stamp is flat, upright and bordered, `rotate(0deg)`; "slip" cards and a bell for "ring" are mild literalism. | LOW |
| | B: only the octagon "stop" gem. C: the rotated, animated stamp over the seam (`:182`) and zigzag crack lines in the mismatch seam (`:177-178`). | LOW / MED |
| 16 Stacked top bars | SK: honesty bar (black, 26 px) plus site header band (67 px, pink, two text rows, three pills); 93 px = 10 % of a 900 px screen; on phone the band turns into about ten lines of text in four rows and the H1 starts at y = 245 (29 % of the screen). `home-390.png`. | HIGH |
| | A, B, C: the same two-tier sticky stack in each (dark honesty bar plus a band of State / Certificate scope / Mode / Witness cells). A also adds a 3 px double rule. | HIGH |
| 17 Numbered markers | SK: numbered circles on both gap pills and gap cards ("1", "2") are an index, not a sequence; the first-run guide 1-2-3 is a true sequence. | LOW |
| 18 Happy path only | SK: `/dev/states` (`states-1440.png`) has designed states for loading, busy, error, lane unavailable, paused, empty, zero-gap, witness silent. This is a strength, but the empty and "not diagnosed" cards are all the same dashed box with an icon and one line, so the formula shows. Mockups show only the happy and ring states (not assessable). | LOW |
| 19 Tabular numerals | SK: no `tabular-nums`. Rows list shows "#1 Ethiopia Yirgacheffe, 250 g $18.00" in the sans face directly beside "PAID $18.00" in mono; amounts do not align between columns. A and B use mono for numbers, so they align by construction; C sets `tabular-nums` on the ledger (2 uses). | MED (SK) |
| 20 Marketing copy | None found in any screen: copy is specific and honest ("Your handler said OK, but the books did not change."). | 0 |
| 21 Radius drift | SK 5 radius values (10 px on 47 elements, pill on 15, circle on 7, 6 px on 5, 14 px on 4); B nests 4, 6 and 8; C uses 8 distinct radii in one landing file. | MED (SK, B), HIGH (C) |

### Root cause in our own code (this matters more than the individual rows)

`tokens.css` and `globals.css` build four tells into the system, so they cannot be "polished away" component by component:
1. Every tone is a triple of line, background and ink (`--red-line`, `--red-bg`, `--red-ink`, and the same for amber and blue), applied by `[data-tone]` to any element. That is tell 6 as architecture.
2. `--accent-width: 6px` ("the colored edge of a gap card") is tell 2 as a token.
3. `--eyebrow-case: uppercase` with `--eyebrow-tracking: .06em`, applied by one rule to eight selectors, is tell 3 as a token.
4. `--radius`, `--radius-sm`, `--radius-lg` and a `.card`-style border on every region make the card kit the only layout vocabulary available.
The three mockup directions do not fix this; they re-skin it (and A swaps it for props). Changing fonts or colors alone, the usual response, moves to the next default (see "Where the look comes from", item 4).

## (c) Ten "do instead" rules, stated as checkable constraints

Each rule has a pass condition a reviewer can check on a screenshot, and where possible a number from `tools/measure.mjs`. Baselines are the skeleton's measured values at 1440 px.

1. Container budget. At most 3 bordered or filled containers (not counting buttons and inputs) in any 900 px slice of the page, at most 12 on the whole page, and no container inside another container. Group with whitespace, alignment and a single 1 px rule. Rows of a list are table rows, not cards. Baseline: 22 in the first viewport, 71 on the page, 3 deep.

2. Status color lives on the status mark only. A state (gap, tied, unverified) may color its icon, its one-word label, and nothing else: no tinted background, no colored border, no colored edge or bar on any container, no colored sentence longer than 3 words. The remaining signals (icon shape, word, border style of the mark) stay, per our own contract. Check: zero containers whose background is a status tint; tinted pixels under 2 % of any viewport (baseline 15.4 % and 18.7 %); zero elements with a 3 px+ border on one side only (baseline 7).

3. Labels are sentence case with no tracking. At most 3 text elements per screen use all-caps or letter-spacing above 0.02em, and only for a status word. A label that names the category of the value right below it ("PAYPAL SAYS" over "REFUNDED $48.00") becomes one column header written once or part of the sentence. Baseline: 56 all-caps elements, 32 tracked.

4. Marks budget. At most 1 pill-shaped element per 900 px, and only for a state or a control; metadata ("planted by us", "sample data", "final", error codes) is plain text in one line or a definition list. Icons only on the status mark and on buttons whose label is ambiguous without one; none before headings, labels or banner sentences, and no icon repeats the meaning of the word next to it. Baseline: 22 pills, 28 icons on the home page.

5. One job per text. No sentence of 5 or more words appears twice on a screen (a repeat becomes an anchor link); a hint line under a control stays only if covering it would stop a first-time user from acting. Baseline: "$96.00" x5, "Your handler said OK, but the books did not change" x4, "recorded" x8, plus hints that fail the cover test ("arrow keys work", "Nothing here calls PayPal or an AI service").

6. One focal element and a real numeric style. Exactly one element per viewport is larger than 28 px (the verdict); everything else is 20 px or less; at most two weights are used (400 and 600); no more than 15 % of text elements are 600 or heavier; every column or run of figures (amounts, times, IDs) uses tabular numerals; the mono face is used for IDs, amounts and timestamps only, under 15 % of text. Baseline: 48 % at weight 700, no tabular-nums.

7. Spacing with rhythm. Use a 3-step scale with at least a 2x ratio between steps (for example 8 / 24 / 64): the gap between items inside a group is the smallest step, between groups the middle step, between sections the largest. In every parent, in-group gap is smaller than between-group gap by at least 2x. Baseline: sections 28 px apart, children inside a card 16 px apart (1.75x), siblings of unequal relation share the same gap.

8. Top-of-page budget. The first heading starts within 120 px of the top at 1440 and within 160 px at 390; no more than one bar above it, no more than one sticky element; the honesty statement and the run mode are one sentence in that bar, not five chips. Baseline: heading at y = 113 (two bars, 93 px) at 1440 and y = 245 at 390.

9. No props, no ambient motion, no decoration. Zero infinite animations except a spinner for a pending request; no overshoot or bounce easing; no gradient, glass, glow or shadow used as decoration; no rotation, blend mode, texture, zigzag or perforation. One object metaphor at most, and it must be flat, upright, and carry the verdict word itself. Check: grep for `rotate(`, `mix-blend-mode`, `clip-path`, `backdrop-filter`, `animation: ... infinite`, `*gradient(` in the stylesheet; each hit needs a one-line reason that names the data it carries.

10. Type and palette are chosen, then proven not to be a cluster. At most 2 families, each with a written one-line reason; at most 1 chromatic hue besides the three status hues, and chromatic pixels outside status marks under 5 % of a viewport; the result must match none of: Inter, Geist, Space Grotesk, Instrument Serif or Roboto as the display face; warm cream plus serif plus terracotta; near-black plus one acid, electric or vermilion accent on a permanent dark theme; zero-radius hairline broadsheet. Check: read the font names and sample five background colors; if any matches a cluster, justify it in writing against our content (a ledger, evidence, honesty) or change it.

How to run the checks: `node <session scratchpad, outside the repo>/design-research/tools/measure.mjs <url> <width> <out.json>` gives rules 1-4 and 6 as numbers (boxed containers, nesting, pills, side borders, all-caps, icons, weights, font sizes, fonts); `rhythm.mjs` gives tinted-pixel share (rule 2); `stack.mjs` the top stack (rule 8); `rep.mjs` repeated phrases (rule 5). Rules 7, 9 and 10 need a grep and eyes. Caveat: the scripts count my definitions of "container" and "pill", so use them for before and after comparison, not as absolute scores.

A 10-second human test to add: (1) squint at the screenshot at 25 %: do you see one focal element and clear groups, or a field of equal boxes? (2) Cover the labels in capitals: is anything lost? (3) Count the colors that are not grey: more than the status hues means decoration. (4) Cover every sentence you have already read elsewhere on the screen.

## Sources

Primary or near-primary:
- Anthropic frontend-design skill (raw file read 2026-10-19): https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md (same text in anthropics/claude-plugins-official)
- Anthropic cookbook, "Frontend Aesthetics: A Prompting Guide": https://github.com/anthropics/claude-cookbooks/blob/main/coding/prompting_for_frontend_aesthetics.ipynb
- Krebs, "Scoring Show HN submissions for AI design patterns" (2026-04-20; 1,590 pages): https://www.adriankrebs.ch/blog/design-slop/ ; detector https://github.com/AdrianKrebs/design-slop-cop ; HN thread (333 points) https://news.ycombinator.com/item?id=47864393
- HN, "How our vibe coded website looks like a designer made it" (2026-09-29): https://news.ycombinator.com/item?id=49901973
- HN comments: DaiPlusPlus 2026-08-17 https://news.ycombinator.com/item?id=49330562 ; DaiPlusPlus 2026-08-05 https://news.ycombinator.com/item?id=49187385 ; kaelwd 2026-07-11 https://news.ycombinator.com/item?id=48869208

Practitioner and vendor (mostly selling a fix, read accordingly):
- impeccable.style, "The visible tells of AI design" (59 detector rules): https://impeccable.style/slop
- Fountain Institute, "7 signs a UI has been vibe coded": https://www.thefountaininstitute.com/blog/signs-vibe-coded-ui
- noqta, "AI design slop: overused UI patterns": https://noqta.tn/en/blog/ai-design-slop-overused-ui-patterns-fix-2026
- SaaSUI, "Why your SaaS UI looks AI-generated": https://www.saasui.design/blog/saas-ui-looks-ai-generated
- Laith0003 UX skill wiki: https://github.com/Laith0003/ux-skill/wiki/How-to-detect-AI-slop-in-your-design and https://github.com/Laith0003/ux-skill/wiki/How-to-design-a-dashboard-with-Claude-Code
- Robots on Payroll, "how to avoid that vibe coded look": https://robotsonpayroll.substack.com/p/how-to-avoid-that-vibe-coded-look
- prg.sh, "Why your AI keeps building the same purple gradient website": https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website
- CodeMySpec: https://codemyspec.com/blog/vibe-coded-websites-look-the-same
- AskCodi, "The AI UI problem nobody talks about": https://askcodi.substack.com/p/the-ai-ui-problem-nobody-talks-about
- braindetox, "Why AI-generated UI feels off": https://braindetox.kr/en/posts/ai_generated_ui_coherence_2026.html
- 925 Studios: https://www.925studios.co/blog/ai-slop-design-tells
- Tessl, de-llm-ui skill: https://tessl.io/registry/maceybaker/de-llm-ui/0.1.0/files
- Heard only through search summaries and not read directly (treat as S): Banani "vibe designing", SaaStr on Gemini 3, Northeast Times (403), a Product Hunt comment on pills and badges.

Tools and raw numbers (not a report; inputs to the tables above): `<session scratchpad, outside the repo>/design-research/tools/` (`measure.mjs`, `stack.mjs`, `rhythm.mjs`, `rep.mjs`, `tree.mjs`, and `m-*.json` outputs) and `.../design-research/raw/` (fetched source files).
