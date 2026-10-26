# Doorbell design benchmark (measured, 2026-10-19)

Purpose: set a design bar for Doorbell (developer tool: per-event delivery timeline, AI-proposed cause as a diff line confirmed by replay, "ring again", printed certificate with "what was checked / what cannot be proven"). Principles only, no brand identity copied.

Screenshots: `<session scratchpad, outside the repo>/design-research/shots/` (file names are given in each table). Scripts: `.../design-research/benchmark-tools/` (`measure-init.js`, `measure2-init.js`, `contrast-*.mjs`, `doorbell-spec-mock.html`).

## 0. Method and caveats

- Playwright MCP, Chromium, viewport 1440x900, pages scrolled once top to bottom so lazy content renders, then **read-only** `getComputedStyle` / `getBoundingClientRect` over up to 9000 visible elements. No login, no form filled or submitted, nothing clicked except cookie controls.
- Cookie banners: Stripe docs offered Accept all / Reject all, **Reject all** clicked. Modern Treasury showed a notice with only a "Close" button (no reject option); it was closed only for the lifecycle crop, the overview shots still show it. Svix docs offered Allow all / Cookie settings: Cookie settings opened, **Allow only necessary** chosen (the Svix docs shot and numbers are from after that). No consent banner was visible in the viewport shots of the other pages (Sentry only shows a reCAPTCHA badge).
- "% chars" = share of visible text characters (direct text nodes). "4-grid %" = count-weighted share of padding / gap values divisible by 4. Contrast = WCAG ratio against the effective background (ancestor backgrounds composited; photo and gradient backgrounds are not, so Mercury's hero is not scored).
- "Real shadows" ignores the all-transparent Tailwind ring defaults that `getComputedStyle` reports as a shadow (my first pass counted them; the table uses the corrected pass).
- Limits: Mercury and Inngest animate sections in on scroll (some lower sections stay hidden, so their numbers describe what rendered). Linear's product mock is a scaled-down render, so its font sizes are layout units. Mercury's product card and Modern Treasury's lifecycle card are images, so those were read visually. Sentry is a contrast case, not one of the ten.
- Tooling note: the Playwright MCP refuses to write outside the project dir, so screenshots were written with `page.screenshot({path})` inside `browser_run_code_unsafe`.

## 1. Per-site measurements

Summary first (details per site below).

| Site (page measured) | Families (% chars) | Sizes holding >=90% of chars | Distinct text colors (top-4 share) | Saturated color used for | Radii | Real shadows | Density: text elements in first viewport |
|---|---|---|---|---|---|---|---|
| Stripe docs /webhooks | system stack 83 + Menlo 17 | 3 (16/14/13 = 95%) | 23 (79%) | one link/button accent | 4/6/8 | 9 rings + 4 soft | 84 |
| Increase /documentation/webhooks | TT Interphases 80 + Input Mono 20 | 3 (16/13/14 = 96%) | 12 (89%) | links on dark code panes | 4/8/12 | 0 | 104 |
| Increase home | TT Interphases 94 + Input Mono 6 | 7 (13 sizes in all, incl. UI mocks) | 16 (63%) | mint CTA/links, lime badge | 8/12/16/pill | layered, all <=0.04 alpha | 29 |
| Modern Treasury home | mt-sans 77, mono 15, display 8 | 4 (16/14/13/18 = 91%) | 11 (77%) | one green family | 2/4/8/pill | 6 inset 1px rings, 0 elevation | 17 |
| Mercury home | arcadia 91 + display 9 | 4 (12/16/18/21 = 92%) | 5 (99%) | 1 CTA (3 buttons) | 4/12/pill | 4 faint | 27 |
| GitHub Actions run + job | Mona Sans 43-90 + ui-monospace | 2-4 (12/14 = 93%) | 5 (99%) | links only; status on icons | 6 (3 on tiny) | 0.04-alpha 1px | 60-71 |
| Resend home | Inter 63, Commit Mono 27, display 9 | 4 (14/12/18/16 = 92%) | 21 (71%) | status chips, code colors | 4/6/8/16/24/pill | 12 rings, 8 at 0.10 | 14 |
| Svix Play (empty state) | Inter 87 + SF Mono 13 | 3 (14/20/12 = 91%) | 6 (97%) | one blue (links, dot, 2px bar) | 6/8/pill | 0 | 15 |
| Svix docs /retries | system sans 91 + mono 3 | 3 (16/14/14.4 = 92%) | 8 (94%) | blue links | 4/6/8 | 2 faint (0 1px 2px .05) | 71 |
| Linear home (scaled app mock) | Inter 85 + Berkeley Mono 15 | 5 (15/13/12/14/24 = 90%) | 14 (83%) | accent on tiny controls | 4/8/9/12/pill | popovers 0 2 32 .25 | 63 |
| Inngest home | CircularXX 61 + mono 20 + display 13 | 6 (16/18/26/13/12/20 = 90%) | 15 (87%) | coral CTA; green only in chips | 6/8/10/pill | 15 rings | 37 |
| Stripe Press | Ivar Text 51 + Ivar Headline 49 | 3 (16/25/14 = 91%) | 21 (color per book) | artwork-driven | ~0 | 0 | 8 |
| Sentry /product/tracing (contrast) | Rubik 43 + Monaco 56 | 4 | 20 | purple/pink/syntax | 3/8/9/10/pill/round | 18 + 15 | 19 |

### 1.1 Stripe docs: docs.stripe.com/webhooks
Shot: `stripe-webhooks-docs.png` (viewport, after Reject all).

| Metric | Value |
|---|---|
| Fonts | `-apple-system` stack 83% + Menlo 17%; no webfont loaded (`document.fonts` empty) |
| Scale (px, % chars) | 12 (1), 13 (15), 14 (18), 14.4 inline code (2), 16 (62), 21 (1), 24 lead (0); H1 32/700 |
| Body / UI | 16/26 (1.63) 400 #3c4257 on #fff = 9.96:1; UI 14/20; small 13/19 |
| Tracking | 0 everywhere |
| Numbers | 22 numeric tokens (HTTP codes), 100% in Menlo; 0% `tabular-nums` |
| Text colors | 23 distinct, 9 over 1%; #3c4257 46%, #414552 21% (code), #c1c9d2 7% (dark code pane), #1a1f36 5%, #5469d4 5%; 93% of chars >=7:1, none <4.5:1 |
| Surfaces | 12 bg colors: #fff, #f7fafc sidebar, #f4f7fa code chips (61 uses), navy #212d63 code panes |
| Saturated | one accent #5469d4: link text (1,120 chars) and buttons; the rest is code syntax inside dark panes |
| Borders | 75 containers, 46 bordered, 41 of 46 are 1px, **42 of 46 are one-sided dividers**; #ecf1f6 (28), #d4dee9, #e3e8ee |
| Shadows | 9 rings `0 0 0 1px #d4dee9`; 4 soft `0 1px 1px rgba(19,19,25,.16)` |
| Radii | 4 (12), 6 (11), 8 (2) |
| Spacing | padding 16 (209), 4 (148), 8 (117), 12 (104), 20, 32; gap 4 (159), 8 (110), 6 (74); 78% / 79% on 4-grid, 44% on 8-grid |
| Width / density | article column 799 px; 3 columns (nav 280, article, TOC ~190); 84 text elements in first viewport; nav rows 28-32 px |
| Status | "Delivered / Pending / Failed" and HTTP codes are **neutral code chips**: 14.4px Menlo, #3c4257 on #f4f7fa, 1px #d4dee9, radius 6, padding 2px 4px. No color. |
| Empty / unknown | none on page; "Optional" appears as small gray tag after headings |

### 1.2 Increase: increase.com and /documentation/webhooks
Shots: `increase-home-top.png`, `increase-home-full.png`, `increase-compliance-card.png` (crop), `increase-docs-webhooks-top.png`, `increase-docs-webhooks-full.png`.

| Metric | Home | Docs page |
|---|---|---|
| Fonts | TT Interphases Pro 94% (variable 100-900) + Input Mono 6% | same 80% + Input Mono 20% |
| Scale | 10, 11, 11.5, 12 (8%), 12.5, 13, 14 (30%), 16 (22%), 20 (12%), 24 (8%), 32 (9%), 40 | 13 (20%), 14 (6%), **16 (70%)**, 20, 24; H1 34/700, H2 24/500, H3 20/500 |
| Body / UI | 14/20 (1.43) 23%, 16/24 15%, 12/16 7% | 16/24 #2f3e4d on #fff = 10.95:1 (96% of chars >=7:1) |
| Tracking | 40px H2 -0.02em; 32px -0.01em; body 0 | H1 -0.04em, H2 -0.04em; body 0 |
| Numbers | 76% of numeric leaf elements `tabular-nums` (41 elements) | codes in Input Mono 13px (57%) |
| Text colors | 16 distinct: #1d2a36 18%, #657482 17%, #c0c9d1 16%, #8995a1 12%, #334352 10%; hero lead-in is deliberately faded #c0c9d1 = 1.68:1 (18% of chars <3:1: a craft trick, not a rule to copy) | 12 distinct; #2f3e4d 73% |
| Surfaces | 23 bg colors; #fff, #151e29 dark panel, #f5f6f7 | #fff, #1f2937 code block, #e9edf2 inline code |
| Saturated | mint #31f2bf (links + CTA on dark, 142 chars), lime #e4ff33 badge; everything else neutral | mint only inside code blocks |
| Borders | 77 of 96 containers have a 1px border: #edf1f5 (28) = 1.14:1 vs white; table row divider #f5f6f7 = 1.08:1 | 7 of 17 |
| Shadows | 58 soft instances, three stacked layers `0 1px 3px .04 / 0 5px 5px .03 / 0 11px 7px .02` | 0 |
| Radii | 8 (25), 12 (20), 16 (11), pill (6), 6 (3) | 4, 8, 12 |
| Spacing | padding 8 (70), 24 (69), 12 (64), 16 (30); gap 8 (48), 10, 16, 32; 70% / 69% on 4-grid | 79% / 100% |
| Width / density | container max 1160 (13 uses); header 65 px, white at 95% alpha, 1px bottom border | prose 672 px; header 68 px; 104 text elements in first viewport |
| Tables | row pitch **38 px** (padding 10/26/10/16); name 12.5/500; amounts **12/600 tabular-nums right-aligned**; column header 11.5/400 #8995a1 (3.05:1) right-aligned | |
| Key-value rows | **28 px**: label 11/400 #8995a1, value 13/400 #1a2b3b; marker at row end (check, spinner, dot, all gray) | |
| Status / unknown | "Verifying" pill 11/500 #687887 on #edf0f2 (3.97:1), radius 999, padding 2px 8px, 16 px tall: **neutral gray even though in progress**. Sub-line "gov ID · could not verify" 11px #8995a1 (same muted tier as labels, not red). Caption "running checks" 10px Input Mono + plain sentence "Verifying with IRS, USPS, identity records, and watchlists". Docs header: mint 8px dot + "Status". | |

### 1.3 Modern Treasury: moderntreasury.com
Shots: `moderntreasury-home-top.png`, `moderntreasury-home-full.png` (notice visible), `moderntreasury-lifecycle.png` (crop).

| Metric | Value |
|---|---|
| Fonts | mt-sans 77% (variable), mt-mono 15%, mt-neue-display 4% + mt-neue-text 4% (hero/section headings only) |
| Scale | 10, 11, 12.5, 13 (13%), 14 (33%), 16 (36%), 18 (9%), 21, 32 (3%), 47 (4%), 71 (1%) |
| Body / UI | **weight 360** 16/24 #151515 at 80% alpha (9.28:1 on #f8f5f4); 14/21 at weight 330; headings 450 (71/1.10, 47/1.25) |
| Tracking | headings 0; mono labels 10px +0.04em, 11/500 +0.06em, uppercase |
| Text colors | 11 distinct; #151515@.8 45%, #151515 16%, #fff@.6 10%, #161616@.5 6%, green #215b4b 6%, #2a5060 6%; 75% >=7:1, 6% in 3-4.5 (#8a8a8a on white 3.45:1) |
| Surfaces | 13 bg; warm off-whites #f8f5f4 / #f8f7f5 / #f9f6f8; dark green band #0c221d |
| Saturated | one green family (#29735c, #215b4b, tint #bae0cf): 6 elements |
| Borders | 22 of 44 containers, all 1px; rgba(21,21,21,.2) (5), rgba(255,255,255,.2) (5), rgba(23,23,23,.13) (4) |
| Shadows | 6 inset 1px rings (outline buttons), **0 elevation** |
| Radii | 2 (15), 8 (10), 4 (5), pill (3) |
| Spacing | padding 48 (44), 8 (34), 12 (26), 16 (19); gap 12 (38), 4 (35), 16 (33); 84% / 92% on 4-grid |
| Width / density | container 1200 (9 uses); hero measure 896; text blocks 672-800; header 65 px, white at 90% alpha, no border; 17 text elements in first viewport |
| Lifecycle (image) | "Payment order $17,450.00" card, then **APPROVED, PROCESSING, SENT, RECONCILED**: 6 px green dots on a 1 px green rail, ~29 px pitch, 10-11px mono uppercase labels; one hue for the whole lifecycle |

### 1.4 Mercury: mercury.com
Shots: `mercury-home-top.png`, `mercury-home-full.png` (crop y=3000..6600).

| Metric | Value |
|---|---|
| Fonts | arcadia 91% (weights 360 / 420-480), arcadiaDisplay 9%; no mono |
| Scale | 12 (47%: footnotes), 16 (24%), 18 (18%), 21, 24, 28, 32, 42; H1 49 (weight 480) |
| Tracking | 12px +0.02em; headings +0.010 to +0.015em (positive, dark theme) |
| Text colors | **5 distinct; two carry 98%**: #ededf3 67% (15.25:1 on #171721) and #c3c3cc 31% (10.16:1) |
| Surfaces | 8-9 bg: #171721 page, #1e1e2a card, #272735, translucent tints |
| Saturated | #5266eb on **3 buttons only** (white on it = 4.71:1) |
| Borders / radii | 24 of 46 containers 1px #afb1cd@.36 (2.18:1, the strongest hairline measured); pill (20), 4 (18), 12 (6); buttons 40 px tall |
| Spacing | padding 32 (116), 12, 20, 40; gap 32 (52), 12 (28), 40 (24); 89% / 100% on 4-grid |
| Layout | header 72 px transparent; 27 text elements in first viewport |
| Numbers | balances in the product card are right-aligned with **cents smaller and dimmer** (visual only; the card is an image) |

### 1.5 GitHub Actions: run page, job page, failed run (public repo actions/checkout)
Shots: `github-run-summary-top.png`, `github-run-summary-full.png`, `github-job-steps-top.png`, `github-job-steps-full.png`, `github-run-failure-top.png`.

| Metric | Value |
|---|---|
| Fonts | Mona Sans VF 90% (job page; 43% on run page); ui-monospace for branch chip, annotation text |
| Scale | job page 14 (72%), 16 (9%), 12 (8%), 20 (6%), 24 (5%); run page 12 (65%), 14 (28%); line-heights 14/20, 12/20, 16/24, 20/30 |
| Weights | 400 for most, 500 for tabs/labels, 600 for names/titles; none above 600 |
| Text colors | **5 distinct in total**: #59636e 51% (6.11:1 on #fff, 5.74:1 on #f6f8fa), #1f2328 22% (15.80:1), #0969da 21% (5.19:1), #fff, #25292e; no char under 4.5:1 |
| Surfaces | #fff page, #f6f8fa step list and panels, black 72 px top bar |
| Saturated | #0969da on links (400 chars) and 1 button; the only other colors are status icons |
| Borders / radii | 16 of 21 containers 1px #d1d9e0 (1.43:1); **radius 6 on all 16 containers and all buttons** (3 on tiny chips) |
| Shadows | `0 1px 1px rgba(26,26,51,.04)` + `0 1px 2px .03`: effectively none |
| Spacing | padding 8 (93), 6 (52), 12 (46), 16 (45), 4 (25); gap 8, 4, 12; 78-80% / 100% on 4-grid |
| Layout | side nav 272-312 px + main 1041 px; 60-71 text elements in first viewport |
| Row heights | **step rows 40 px**, job list rows 32 px |
| Status | Header: 22 px circle icon (green check / red x #d1242f = 5.24:1) + title 20/600. "Status" is a 12px label **above** the value "Success" or "Failure" in **16/600 #1f2328 (neutral)**. Step rows: 16 px icon in neutral #59636e (success is quiet); failure adds "Error:" 12/600 red. |
| Timeline row | icon (16 px, fixed x) + 12 px gap + step name 14/400 #59636e; duration right-aligned 12px (job list: 41s, 41s, 9s, 18s, 6s); header sentence "succeeded 2 days ago in 41s" 12px |
| Summary strip | one bordered panel, four columns "Triggered / Status / Total duration / Artifacts": 12px label above 16/600 value; empty value is "–" |
| Failure cause | annotation: red 16 px icon + title 14/600 + 12px mono sentence: "This workflow run required approval but was not approved before it expired." |
| Gating | "Sign in to view logs" (says what is missing) |

### 1.6 Resend: resend.com
Shots: `resend-home-top.png`, `resend-home-full.png`, `resend-logs-card.png` (crop).

| Metric | Value |
|---|---|
| Fonts | Inter 63% (UI/body), Commit Mono 27%, ABC Favorit 6% (56px section titles), Domaine 3% (96px serif hero) |
| Scale | 12 (21%), 14 (50%), 16 (7%), 18 (14%), 20 (3%), 24 (2%), 56 (2%), 96 hero; 14/22 (1.6) 32% |
| Tracking | 56px -0.05em; body 0 |
| Numbers | 94 numeric leaf elements, 94% mono (line numbers); `tabular-nums` 0% (mono does the job) |
| Text colors | 21 distinct; #a1a4a5 48% (8.37:1 on #000), #f0f0f0, #ebeced; 89% >=7:1 |
| Saturated | status green #46fea5@.83, violet #9281f7 and amber #ffca16 in code samples; none in chrome |
| Borders | 75 of 97 containers 1px `rgba(212,234,255,.19)` x59 (1.49:1 on black) |
| Shadows | 12 rings (`0 0 0 1px`), 8 soft `0 1px 3px .10` |
| Radii | 16 (33), 6 (27), 8 (13), pill (10), 24 (8), 4 (8) |
| Spacing | padding 2 (116), 16 (107), 4 (89), 14 (85), 8; gap 16 (122), 8 (72), 6; 57% / 87% on 4-grid |
| Layout | container 1280; header 58 px; 14 text elements in first viewport |
| Status | "Delivered" chip: 12/500, text #46fea5@.83 on rgba(34,255,153,.12), radius 10, padding 0 8, 28 px tall. Log lines: `HTTP 200: { "id": "c0abae96-..." }` in mono with **progressive fade** on older lines. "new" and "error" are plain colored words, no chip. |

### 1.7 Svix: play.svix.com and docs.svix.com/retries
Shots: `svix-play-top.png`, `svix-play-full.png`, `svix-docs-retries-top.png`, `svix-docs-retries-full.png`, `svix-docs-cookie-settings.png` (banner options).

| Metric | Play (empty state) | Docs (retry schedule, after "Allow only necessary") |
|---|---|---|
| Fonts | Inter Variable 87% + SFMono 13% | system `ui-sans-serif` 91%, `ui-monospace` 3% |
| Scale | 14 (67%), 20 (20%), 12 (4%), 16, 30 (2%), 10 uppercase label | 16 (53%), 14 (36%), 14.4 inline code (3%), 30 (3%), 12 (3%); H1 36/700; prose 16/28 (1.75) #314158 = 9.92:1 |
| Tracking | 10px uppercase label "LISTENING ON" | H1 -0.025em, H2 -0.025em |
| Text colors | 6 distinct: #71717a 52% (4.59:1 on #f8f9fd), #495072 22% (7.85:1), #3182ce 19% (**4.03:1 on white, below AA**) | 8 distinct, 5 over 1%: #314158 53%, #4a5565 34% (7.24:1), #101828 4%, #006be6 3% (4.74:1), #0f172b 3%; 96% of chars >=7:1 |
| Surfaces | 3 bg: #f8f9fd page, #fff panels, blue | #fafafa page, #f3f4f6 sidebar |
| Borders / radii | 7 of 8 containers 1px (#dfe0ea, #e4e4e7); 2px blue bar under header; radius 6 (4), pill (2), 8 (1); shadows 0 | 11 of 13 containers 1px #e5e7eb (1.19:1), mostly one-sided; radius 6 (6), 4 (2), 8 (1); 2 faint `0 1px 2px rgba(0,0,0,.05)` |
| Spacing | 95% / 71% on 4-grid | 54% / 95% |
| Layout | left rail 240 px ("Messages" + count chip + trash), main 1200 px, header 64 px; 15 text elements | prose 817 px; header 64 px; 71 text elements; list rows 24-32 px |
| Empty state | **"No Webhook Messages Received"** (20/600 #495072) + **"Send a request to this URL to get started"** (14/400) + the URL in a 1px bordered box with a copy button; status label "LISTENING ON" with a blue dot above a mono URL; footer "Free forever, no sign up required." | |

### 1.8 Linear: linear.app
Shots: `linear-home-top.png`, `linear-home-full.png`. The product mock is scaled, sizes are layout units.

| Metric | Value |
|---|---|
| Fonts | Inter Variable 85% + Berkeley Mono 15%; weights 300 / 400 / **510 / 590** (variable axis, not 500/600) |
| Scale | 12 (19%), 13 (24%), 14 (16%), 15 (25%), 24 (6%), 32, 48 (3%), 64, 72 |
| Body / UI | 15/24 (1.6) -0.011em 19%; 14/24 13%; 13/20; labels 12/510 |
| Tracking | 15px -0.011em; 48px -0.022em; 12-14px 0 |
| Numbers | 37 elements with `font-variant-numeric: lining-nums tabular-nums`, e.g. "2min ago" 12px #62666d |
| Text colors | 14 distinct; four tiers carry 83%: #f7f8f8 8%, #d0d6e0 33%, #8a8f98 33% (6.13:1 on #08090a), #62666d 9% (**3.30:1 on #0f1011**, used for timestamps) |
| Surfaces | 26 bg; three near-black layers #08090a (page), #0f1011 (panels, 33 uses), #161718 |
| Saturated | tiny: status tags in mocks (borders #f34e52, #27a644), accent #4ea7fc (4 uses) |
| Borders | 81 of 95 containers 1px `rgba(255,255,255,.08)` x48 (1.21:1) or .12 x11 (1.38:1) |
| Shadows | 24 rings (`0 0 0 1px rgba(0,0,0,.2)`), 18 elevation (popovers `0 2px 32px rgba(0,0,0,.25)`) |
| Radii | pill (34), 8 (24), round (19), 9 (18), 12 (16), 4 (12) |
| Spacing | padding 32 (162), 8 (104), 4 (98), 12 (73), 6 (67), 10 (46); gap 8 (176), 4 (122), 6 (108); 68% / 69% on 4-grid; **6 and 10 used as half-steps** |
| Layout | header 73 px, 1px bottom hairline; 63 text elements in first viewport (mock) |
| Timeline | issue Activity feed: icon gutter + one-line sentence ("Linear moved from Todo to In Progress") + middle dot + muted relative time; system events are **unboxed lines**, only human comments get a 1px box |

### 1.9 Inngest: inngest.com
Shots: `inngest-home-top.png`, `inngest-home-full.png`.

| Metric | Value |
|---|---|
| Fonts | CircularXX 61%, CircularXXMono 11%, WhyteMonoV1 9%, WhyteV1 13% (display, 64-72px) |
| Scale | 12 (6%), 13 (9%), 16 (34%), 18 (27%), 20 (3%), 26 (11%), 64 (3%), 72; labels 12/600 mono uppercase **+0.067em** |
| Tracking | display -0.02 to -0.035em; body -0.01em; caps labels +0.05-0.067em |
| Text colors | 15 distinct; #fff 44% (17.04:1 on #1c1c1c), #b3b3b3 31% (8.13:1), #9b9b9b 8% (6.13:1) |
| Saturated | coral #f65c4f for CTA + small labels (15 buttons, 13 bgs); green only in status chips |
| Borders / radii | 2 of 17 containers bordered; radii 6 (8), 10 (4), pill (2) |
| Status chip | "COMPLETED \| 1.2s": 11px mono uppercase +0.06em, text #66bd8b on rgba(102,189,139,.14) (5.79:1), radius 999, **20 px tall**, padding 0 10, 136 px wide; a second, amber chip rgba(183,134,105,.15). Status word and duration live in one chip, placed in the left gutter of the step it annotates. |
| Layout | header 88 px; 37 text elements in first viewport |

### 1.10 Stripe Press: press.stripe.com
Shots: `stripe-press-top.png`, `stripe-press-full.png`. Editorial end of the range.

| Metric | Value |
|---|---|
| Fonts | one serif superfamily in two optical sizes: Ivar Text 51%, Ivar Headline 49% (+ Ivar Display) |
| Scale | 14 (18%), 16 (46%), 18, 21, 25 (27%); prose 25/37.5 weight 500, 766 px column |
| Tracking | +0.02em at 14-16px (serif caps/nav) |
| Colors | text #000 49% / #fff 9% on #201819 page; 21 distinct, but color arrives with each book's artwork, chrome stays black/white; 81% of chars >=7:1 |
| Borders / radii / shadows | 1 of 26 containers bordered, radii 2-3, shadows 0: **no UI chrome at all** |
| Density | 8 text elements in first viewport |

### 1.11 Sentry /product/tracing (contrast case)
Shots: `sentry-tracing-top.png`, `sentry-tracing-full.png`. Rubik + Monaco; **20 distinct text colors**; purple #1f1633 / #150f23 surfaces, pink #e91e63, syntax colors #9ecbff #b392f0 #f97583 on ~900 chars; six radius values (3/8/9/10/pill/round); 18 "16px frame" shadows + 15 soft; squiggle dividers; **31% of chars sit at 3-4.5:1** (#6a737d on #150f23 = 3.88:1). Brand-loud, decorated; it is the useful opposite of the pages above.

## 2. Cross-site patterns that separate crafted UI from generic UI

1. **Two families, mono only for machine strings.** Mono share of characters: Stripe docs 17%, Increase docs 20% (home 6%), Linear 15%, Resend 27%, Modern Treasury 15%, Inngest 20%, Svix docs 3%. Display faces appear only in marketing heroes (Resend 9%, Inngest 13%, MT 8%). HTTP codes, ids, timestamps are mono: Stripe docs 22 of 22 numeric tokens, Resend 94%, Inngest status chips. Doorbell's current UI already splits system-ui / ui-monospace (152 vs 34 elements).
2. **A narrow scale: 3-4 sizes carry 90% of the text.** Stripe docs 3 (16/14/13 = 95%), Increase docs 3 (96%), GitHub job page 4 (95%), GitHub run page 2 (93%), Svix docs 3 (92%), Resend 4 (92%), Modern Treasury 4 (91%), Press 3 (91%). Current Doorbell home: 9 sizes including 13.5 and 15 (other agent's measurement).
3. **Regular body, one emphasis step, tracking only at the extremes.** Heaviest UI weight: GitHub 600, Linear 590, Increase 600, Svix 600 (700 only on page titles); body weight 330-400 (MT 330/360, Mercury 360). Tracking: 0 at 12-16px (GitHub, Stripe docs), negative on display (Increase docs 34px -0.04em, Svix docs 36px -0.025em, Linear 48px -0.022em, Resend 56px -0.05em, Inngest 64px -0.035em), positive on caps under 13px (Inngest +0.067em, MT mono +0.04-0.06em, Increase mono +0.124em). Current Doorbell: weight 700 on 90 elements.
4. **Numbers are tabular, aligned and quiet.** Increase: 76% of numeric elements `tabular-nums`; table amounts 12/600 right-aligned under a right-aligned 11.5px #8995a1 header; Linear: timestamps `lining-nums tabular-nums` in the dimmest tier; Stripe docs, Resend, Inngest: mono for 100%, 94%, all chips. Current Doorbell: 28 of 80 digit elements mono or tabular (35%).
5. **A cool neutral ramp with 4 text tiers, nothing else.** Hues sit at 210-240 degrees: Increase #1d2a36 to #657482, GitHub #1f2328 / #59636e, Stripe #1a1f36 / #3c4257, Svix #0f172b / #314158, Linear #d0d6e0 / #8a8f98, Mercury #ededf3 / #c3c3cc. Distinct text colors: GitHub 5, Mercury 5, Svix Play 6 versus Sentry 20, Press 21, Resend 21. The top four colors cover GitHub 99%, Mercury 99%, Svix docs 94%, Inngest 87%, Linear 83%. Secondary tier stays at 4.8-8:1 (GitHub 6.11, Increase 4.80, Linear 6.13, Inngest 6.13, Mercury 10.16); only metadata dips to about 3:1 (Increase #8995a1 3.05, Linear #62666d 3.30).
6. **Saturated color is rationed: one accent for interaction.** Mercury #5266eb on 3 buttons of 895 visible elements; GitHub #0969da on links (400 chars) and 1 button; Stripe docs #5469d4 on 1,120 link chars; Modern Treasury a single green family (6 elements). Status color lives in small marks only (GitHub 16-22 px icons, Resend and Inngest chips). The loud counter-example is Sentry (purple + pink + 20 text colors).
7. **Status is quiet: shape plus word, color on the mark or a 12-15% tint.** GitHub prints "Success"/"Failure" in neutral 16/600 and colors only a 22 px icon; step success icons are neutral gray. Resend's Delivered chip uses a 12% tint (text 12/500, radius 10, padding 0 8); Inngest 14% tint, 20 px high, 11px mono caps; Increase shows in-progress "Verifying" as a neutral gray pill; Stripe docs shows Delivered / Pending / Failed as plain code chips; Modern Treasury's lifecycle is one hue.
8. **Hairlines instead of boxes and shadows.** Border contrast against the surface: Increase 1.08-1.14:1, Stripe docs 1.14-1.36, Svix 1.19, Linear 1.21-1.38, GitHub 1.43, Resend 1.49 (Mercury 2.18 is the outlier). Stripe docs: 42 of 46 borders are one-sided dividers. Elevation shadows: Increase layered at <=0.04 alpha (docs page 0), Modern Treasury 0, Svix Play 0, Press 0, GitHub <=0.04, Linear only popovers.
9. **One dominant radius.** GitHub 6 px on 16 of 16 containers and every button; Increase 8 (25) then 12 (20); Stripe docs 4 (12) and 6 (11); Svix Play 6; Linear 8 (24); Modern Treasury 2 (15). Pills are reserved for status and tags (Resend 10, Increase 6, Svix 2). Sentry uses six values.
10. **A 4 px base with 8 px rhythm and 6 px half-steps.** Share of paddings divisible by 4: Svix Play 95, Mercury 89, MT 84, Sentry 82, GitHub 78-80, Increase docs 79, Stripe 78; gaps: GitHub, Mercury, Increase docs 100, Svix docs 95, MT 92. Common paddings: GitHub 8/6/12/16, Stripe 16/4/8/12, Increase 8/24/12/16, Linear 32/8/4/12/6.
11. **Reading measure 672-817 px; app pages are a side rail plus one fluid column.** Increase docs 672 at 16/24, Stripe docs 799 at 16/26, Svix docs 817 at 16/28, Modern Treasury 800, Press 766 at 25/37.5. Marketing containers 1152-1280 (Sentry 1152, Increase 1160, MT 1200, Resend 1280). GitHub: 272 px rail + 1041 px main.
12. **Tool pages are dense with a small page title; brand pages are not.** Text elements in the first viewport: Increase docs 104, Stripe docs 84, Svix docs 71, GitHub 60-71, Linear mock 63 versus Modern Treasury 17, Resend 14, Press 8. Row heights 28-40 px (GitHub steps 40 / jobs 32, Increase table 38 / key-value 28, Stripe nav 32). Page titles on tool pages 20-36 px (GitHub 20/600, Svix Play 30/700, Stripe 32/700, Increase 34/700, Svix docs 36/700) against 64-96 px on brand heroes. Headers 56-73 px with a 1px bottom hairline and 90-95% white (Increase 65/68, MT 65, Linear 73, Svix 64).
13. **A timeline is a rail plus uniform one-line rows; only the node changes.** GitHub step rows: 40 px, 16 px icon at a fixed x, 14/400 name, 12px duration at the right. Modern Treasury lifecycle: 6 px nodes on a 1 px rail, ~29 px pitch, mono caps. Linear activity: icon gutter + sentence + muted relative time, system events unboxed. Inngest: status word and duration in one chip. Svix retry schedule: one 24 px row per attempt.
14. **Unknown and empty states say what is missing, what is running, or what to do, in muted text.** Increase: "gov ID · could not verify" in the label tier, "running checks", "Verifying with IRS, USPS, ...". Svix Play: "No Webhook Messages Received" + "Send a request to this URL to get started" + the URL. GitHub: "Sign in to view logs", empty value "–", failure cause as a full sentence. None of them paints "unknown" in the failure color.
15. **Key-value ledger rows for evidence.** Increase: 28 px rows, 11px muted label against 13px value, marker at the row end. GitHub run strip: 12px label above a 16/600 value, four columns in one 1px panel. Both separate label tier from value tier by size and tone, not by boxes.

## 3. Starter spec for Doorbell (validated in `doorbell-spec-mock.html`, screenshot `shots/doorbell-spec-mock.png`)

Light theme first (the certificate prints). The mock was measured with the same script as the benchmark: 6 font sizes, 4 text colors, 2 border colors, 1 radius (6 px) plus pill, 0 shadows (the hollow ring marks are drawn with an inset box-shadow), 83% of paddings on the 4-grid, 61 text elements in the first viewport, 100% of digit elements tabular or mono, no character below 4.5:1 (43% at 4.5-7:1, 57% at >=7:1; lowest pair 5.58:1).

### 3.1 Typeface pair (Google Fonts)
- **IBM Plex Sans** 400 / 500 / 600 for UI and prose; **IBM Plex Mono** 400 / 500 for ids, event types, HTTP codes, offsets, diff lines. Fallbacks `system-ui` and `ui-monospace`.
- Why: a ledger/document voice for the certificate, and it is not the Inter default that three of the ten sites share. Verified with fontTools on the served latin files: Plex Sans digits are equal-width by default, Plex Mono is monospaced; still set `font-variant-numeric: tabular-nums` on `body`. Alternative if a sharper grotesk is wanted: Geist + Geist Mono (Geist has `tnum`).

### 3.2 Type scale (px / line-height / weight / tracking)
| Role | Size / lh | Weight | Tracking | Use |
|---|---|---|---|---|
| Caps label | 12 / 16 | 500 | +0.06em, uppercase | column heads, certificate keys, diff caption (nothing else) |
| Secondary | 13 / 20 | 400-500 | 0 | table cells, helper text, buttons (500) |
| UI default | 14 / 20 | 400 / 500 / 600 | 0 | body in tool views, row titles 500, counts 600 |
| Prose | 16 / 26 | 400 | 0 | certificate and explanations, max 680 px |
| Section | 20 / 28 | 600 | 0 | section headings |
| Page title | 28 / 34 | 600 | -0.01em | one H1 per page |
| Mono | 13 / 20 (12 / 16 in attempt rows) | 400 / 500 | 0 | ids, codes, offsets, diff |
Nothing above 600. No half sizes (13.5, 15).

### 3.3 Neutral palette (cool slate, hue about 215)
| Token | Hex | Contrast |
|---|---|---|
| canvas | #FFFFFF | n/a |
| surface-1 (detail panel, code, rail background) | #F6F7F9 | n/a |
| surface-2 (hover, selected, neutral chip) | #EEF0F4 | n/a |
| hairline | #E4E7EC | 1.24:1 on white |
| hairline-strong (inputs, rail, buttons) | #CBD0D8 | 1.55:1 on white |
| ink-1 (titles, values) | #14191F | 17.67:1 on white, 16.48 on surface-1 |
| ink-2 (body) | #3B434E | 10.01:1 / 9.33 |
| ink-3 (labels, ids, offsets, helper) | #586271 | 6.18:1 / 5.76 (5.41 on surface-2) |
| ink-4 (placeholder, disabled, never essential text) | #8A93A1 | 3.10:1 |

### 3.4 Three status colors (+ one interaction accent)
One hex serves the dot, the word if colored, and the tint (`color-mix(in srgb, <hex> 10%, #fff)`).
| Meaning | Hex | on white | on surface-1 | on its 10% tint | Mark |
|---|---|---|---|---|---|
| Tied (books match PayPal) | #17703F | 6.13:1 | 5.72:1 | 5.32:1 (#E8F1EC) | filled 8 px dot |
| Gap (books differ or event never booked) | #B42318 | 6.57:1 | 6.13:1 | 5.58:1 (#F8E9E8) | filled 8 px dot |
| Unverified (cannot be proven) | #8A5300 | 6.33:1 | 5.90:1 | 5.48:1 (#F3EEE6) | **hollow ring**, never a red x |
| Accent (links, focus, the one primary button) | #2B3FB8 | 8.38:1 | 7.82:1 | white on accent 8.38:1 | n/a |
Shape plus word carries the meaning, so grayscale printing and red-green color blindness still work. The 3 status hues never appear as large fills; unverified never borrows the gap color.

### 3.5 Spacing scale
4, 8, 12, 16, 24, 32, 48, 64. 2 and 6 only inside chips, rails and dots. Constants: top bar 56; page gutter 24; list column max 1040; prose max 680; list row 40; timeline step min 40; attempt row 32; key-value row 28 (min); table header 32; tab row 40; page title top at y = 88.

### 3.6 Border, radius, shadow policy
- 1 px hairlines (#E4E7EC) as dividers: header underline, row separators, key-value rows. Prefer a divider to a box; **at most one level of boxing** (page, then panel), no card inside a card.
- Radius: **6 px** for every control, code/diff block and panel; **pill** only for 20 px chips; status marks are circles.
- Shadows: none on static content. Menus and popovers only: `0 1px 2px rgba(20,25,31,.06), 0 8px 24px rgba(20,25,31,.12)`. Focus ring `0 0 0 2px #fff, 0 0 0 4px #2B3FB8`.

### 3.7 Delivery timeline row (list) and expanded timeline
List row, 40 px, grid `24px | 300px | 1fr | 150px | 88px`:
1. gutter (expand chevron, blank when closed);
2. event type in mono 13 ink-1 + id in mono 13 ink-3, middle-truncated (`3KJ9...81`);
3. **mini rail**: four 8 px nodes (sent, received, answered, books) joined by 16 x 1 px #CBD0D8 lines. Observed nodes are ink-3; **only the last node takes the verdict color** (hollow ochre ring if unverified). Column head: "Sent · received · answered · books" in the caps label style;
4. verdict: 8 px dot + word 14/500 ink-1 (neutral word, colored mark);
5. age, mono 13 ink-3, right-aligned, tabular.
Selected row: surface-1 background, no border change.

Expanded panel (surface-1, padding 16 / 8 / 24 / 40): first line = title 14/600 ink-1 and **one** tinted verdict chip (20 px, 12/500, radius pill). Under it a vertical rail (1 px #CBD0D8, x = 4) on a grid `24px | 1fr | 88px`; each step min 40 px with 8 px padding:
- label 14/500 ink-1, a plain sentence of what happened ("PayPal sent it", "Doorbell received it", "Your handler answered 200", "Your books: unchanged");
- detail 13 mono ink-3 (transmission id, counts, "no write observed");
- right column: **offset from sent** in mono 13 ink-3 ("+0.84 s"); absolute time only on the first and last step;
- node 8 px: ink-3 = observed, verdict color = the deciding node, hollow ochre ring = could not be observed.

### 3.8 Attempt row
Hangs off the same rail and grid, **32 px**, no border, no box:
- column 2: `#n` mono 12 ink-3 (32 px), HTTP code mono 12/500 ink-1 with a 6 px dot (green 2xx, red 4xx/5xx, hollow ring = no answer), then the outcome in words 13/400 ink-2 ("rejected: signature check failed", "no answer within 10 s");
- column 3: latency mono 13 ink-3 right-aligned on the same edge as the step offsets ("312 ms", "10.0 s").
Failure is stated in words; the row text is not red.

### 3.9 AI cause line and "Ring again"
- One block, 1 px hairline, radius 6, white on the panel. Caption row 12/500 caps ink-3: left "Proposed cause · AI", right "Confirmed by replay · 3 of 3" (a plain count, no sparkle icon, no confidence adjective).
- Diff lines mono 13/20, 10% tint of gap (removed) or tied (added), 24 px gutter with `-` / `+` in ink-3, code text ink-1.
- "Ring again": secondary button 32 px, 13/500, 1 px #CBD0D8, radius 6; helper sentence 13 ink-3 states the effect and the budget ("Resends this event to your endpoint, then checks the books. 2 of 5 rings left for this session."). The accent-filled button appears at most once per page.

### 3.10 Page header and status arrangement
1. Top bar 56 px, sticky, white at 92% + 1 px hairline. Left: wordmark 16/600 and a 14/ink-3 descriptor (hidden under 1100 px). Right: neutral "Sandbox" chip and one secondary button.
2. Title block from y = 88: H1 28/34/600, then one 14/ink-3 meta line (what was scanned, when, how many captures were read back).
3. **Status summary** directly below, one line, severity order: `● 3 gaps   ○ 2 unverified   ● 12 tied` (14/600 count + 14/500 word, 8 px mark, 24 px apart). No KPI cards, no banners.
4. Tab row 40 px (13/500; active ink-1 with 2 px underline, others ink-3) over a hairline, then the 32 px caps column header, then 40 px rows.

### 3.11 Certificate (print)
Prose 16/26 at <=680 px; section titles 20/28/600. "What was checked" and "What cannot be proven" use key-value rows (key 12/500 caps ink-3 in a 248 px column, value 14 ink-2, marker at the right edge as dot + word: "Checked" with the green dot, "Cannot prove" with the hollow ochre ring). Each limit is a complete sentence ("PayPal does not list them, so absence says nothing"), never in the gap color. Footer in mono 12: hash, timestamp, tool version. Meaning survives black-and-white printing because every marker is a shape plus a word.

## 4. Delta against the current Doorbell UI
Source: the other agent's `design-research/tools/m-home-1440.json` (its definitions differ slightly from mine, read directionally).
| Measure | Current home | Spec target |
|---|---|---|
| Distinct font sizes | 9 (12, 13, 13.5, 15, 17, 20, 22, 26, 52) | 6 (12, 13, 14, 16, 20, 28) |
| Weights | 400 (59), 500 (37), **700 (90)** | 400 / 500 / 600 only |
| Boxed containers | 71 (22 in first viewport), nesting up to 2 | at most one level; dividers for rows |
| Pill-like elements | 22 | pills only for 20 px verdict chips |
| Side-tab borders >=3 px / dashed-dotted borders | 8 / 8 | 0 / 0 |
| All-caps elements | 56 | caps only for 12px column heads and certificate keys |
| Digit elements mono or tabular | 28 of 80 (35%) | 100% |
| Status in the list | words in caps pills (TIED, GAP, GAP...) | dot + neutral word; color on the mark |

## 5. Reproduce
Scripts load as init scripts (`window.__measure()`, `window.__m2()`); `contrast-spec.mjs` recomputes every ratio in section 3, `contrast-sites.mjs` the hairline ratios in section 2.
