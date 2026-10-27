# Doorbell: judge pack

A webhook gap finder for PayPal. Text first, for a judge with ten minutes and no API key. All of it can be checked on the deployed site, https://paypal-doorbell.vercel.app/, without signing in.

How to read this pack: text in curly quotes, like “Nothing checked yet”, is copied from the product, and a test checks that the product still says it. A figure followed by a short code in square brackets (the letters G, H, C, L and P with a number) points to a row of the numbers ledger at the end of this pack; the ledger is computed from the measurement files, and the test checks that it is current and that the line citing a row carries the same figure. A figure followed by "log" and a number in square brackets is not in any file of this repository: it comes from the build log, with its date, and is listed at the end of the pack as such. The repository link and the licence file (MIT) are added at publication.

## 1. What it is

Doorbell finds the payments, refunds and disputes that PayPal knows about and a shop's books do not. For each one it says what it can prove and what it cannot, has an AI point at the changed line of the shop's code that explains it, checks that pointer in plain code, then replays real signed events through the good and the bad build to test the change as a whole, and asks PayPal to send the event again only when PayPal lists it. It ends in a certificate that counts what it checked and prints what it cannot prove first.

The product's own one-line pitch, as it is on the first screen: “Doorbell is the tool that looks. It finds the PayPal webhooks your shop never heard or never saved, has an AI point at the changed line of your code behind it, rings them again, and tells you exactly what it still cannot prove.”

## 2. Three minutes, no key, no sign-in

Each page below is the deployed site. Nothing here calls PayPal, the database or the AI: the pages play back runs that were recorded on PayPal's Sandbox [log-12].

<!-- n:ok:start -->
| # | Open | What you will see | Time |
| --- | --- | --- | --- |
| 1 | `https://paypal-doorbell.vercel.app/` | The headline “PayPal refunded $48.00. Your books still say paid.” and under it “No error anywhere.” A bar that never leaves the screen: “Sandbox demo · fictional shop · PayPal test money · bugs are planted by us”. | 20 s |
| 2 | The same page: use the tabs at the top (What happened, How it travelled, Why, The replay, The fix) or scroll | “Each hop said OK. The books never changed.” Then the AI's pointer at two changed lines, with two plain-code checks. Then “Same messages, two builds. Only one saves them.” Then “Fixing the code does not rewrite the books. Only another delivery of the same event can.” | 60 s |
| 3 | The "Ring again" tab, then the Ring again button | A stored real resend plays back in about 13 s (timed by hand on the deployed page on 2026-10-21, not a ledger figure), under the note “A replay of the real resend from Oct 20, 2026, sped up. Nothing is sent to PayPal.” It ends with “The books now say refunded.” and the certificate: “2 gaps found · 2 healed · 0 still open.” | 30 s |
| 4 | The scenario menu at the top, then "Ring again, one never arrived" (`/?s=resend_not_delivered`), then Ring again | An ending that does not heal: “Order #2 now says refunded. Order #3 is still open.” and “Order #3: Resend accepted, not delivered. The gap stays open.” | 30 s |
| 5 | "Rejected after a settings change" (`/?s=cause_not_in_code`), the Why tab | “The cause is not proven.” “The AI found no changed line that explains this gap.” | 15 s |
| 6 | "A dispute nobody heard" (`/?s=dispute_never_heard`) | “PayPal lists a $48.00 dispute on order #2. Your books have none.” and “No webhook of this app asks for dispute events.” | 15 s |
| 7 | `https://paypal-doorbell.vercel.app/certificate?s=refund_never_booked` (the link "Open the owner view") | A printable page in plain sentences: “We checked 3 of your 3 orders against PayPal's own records.” and “This page is not signed. Anyone could edit it, so treat it as a report, not a receipt.” | 10 s |
<!-- n:ok:end -->

Optional, with the owner's token: `https://paypal-doorbell.vercel.app/live`, the live lane (described in the next section). Testing instructions for Devpost, in three lines:

```
Demo: https://paypal-doorbell.vercel.app/  (no sign-in, no API key; the pages play back runs recorded on PayPal's Sandbox)
Path: press "Ring again" in the Ring again chapter, read the certificate, then open the scenario "Ring again, one never arrived"
Live lane (optional): https://paypal-doorbell.vercel.app/live  token: <OWNER: paste the judge token here; it goes in the page's text box, never in the URL>
```

## 3. What is real, what is recorded, what is live

- **Real.** The six stories were run on the deployed shop against PayPal's Sandbox, and the PayPal ids on screen (event, capture, order) are PayPal's. The stories table at the end of this pack gives each one's link and the time it was recorded. The money is Sandbox test money and the shop, Maple Mug, is fictional.
- **Planted by us.** Each bug in these runs is one we put into the shop's webhook handler, and the screen says so next to each one: “bugs are planted by us”. Doorbell did not find them in anyone's real shop. The one run where the planted fault is a wrong webhook id in a setting says it too: “That wrong ID was planted by us, and Doorbell did not find it.”
- **Recorded.** On the recorded pages Ring again plays back the stored result of a real resend, with its long waits cut. The page says so: “Nothing is sent to PayPal.” The AI's answers are stored recordings: “The answer is a stored recording; this page makes no model call.” You do not need an AI key and there is none to enter.
- **Live.** The live lane runs a new order, a planted bug and a refund against PayPal's Sandbox, and needs the judge token. The product says what it costs in time: “A live run against PayPal's Sandbox; it takes a few minutes, because PayPal delivers and lists events on its own clock.” The first end-to-end pass on the real Sandbox was on 2026-10-20 [log-6]. On the hosted site the cause step reads a stored answer first; a live model call is allowed only behind an hourly limit and a money budget, and anything that fails ends as a "not diagnosed" result instead of a guess.
- **Held-out.** The AI step was evaluated on 2026-10-26 on sets sealed by hash before any run [log-9]: 34 of 35 [S1] cases right on the set written in a separate session (the regular-expression baseline 15 of 35 [S2], the sealed checklist baseline 21 of 35 [S3]; on the keyword-free cases 14 of 14 [S4]; confidently wrong 1 of 35 [S5]), and 11.67 of 12 [S6] on cases rebuilt from real public fix commits, 12 of 12 [S7] on their obfuscated twin. The pre-registered verdict (`eval/harness/verdict.ts`) is GREEN. The development-set figures in this pack stay labelled as such.

## 4. The five criteria, with the evidence

### Technological implementation

- **Most of PayPal's webhook API surface is in use.** The product uses: a second webhook of its own, the witness, that receives PayPal's deliveries and checks each signature with PayPal's `verify-webhook-signature`; the webhook management calls, to read which event types the shop's webhook subscribes to; the events list; the resend call; the Orders API and the payments calls (capture read, refund) for the demo shop; and the Disputes API, read only. Each one has a place on the screen: the signature check is the “Doorbell heard it, signature checked” line of the path, the events list is why Ring again waits, and the subscription read is what turns “A dispute nobody heard” from a guess into a fact.
- **The facts are decided by code, not by the model.** A gap is a capture whose PayPal answer differs from the shop's books, found by asking PayPal again. In three scans of a 24-capture session in which the shop had dropped 12 refunds, Doorbell found 12 of 12 in each of 3 scans [G1], raised 0 in each of 3 scans [G2] false alarms, and each scan took 2.8 to 3.2 s [G3] of server time. Each gap is put in one of five evidence classes; in 9 of 9 [G5] trials of three planted bugs the class was the expected one. A claim that an event is missing waits 6 minutes; there were 0 claims [G6] before then.
- **The AI proposes and code checks.** The model returns one of eight categories and the changed lines it cites; no sentence of the model reaches the screen, whose wording comes from templates. Two plain-code checks run first: the cited line must be a changed code line (not a comment, not blank), and the category must fit what the shop answered. Then the replay sends the stored real signed events to the good and the bad build and compares the answers and the books: it confirmed the cause in 9 of 9 [C8] replays. The replay is “a tested result for the whole change, not a proof about any one line”, and the screen says that.
- **Why a model at all.** On the development set the model was right in 19 of 19 [C1] cases in all 3 runs, with 0 wrong [C2] answers shown; a plain-code baseline with regular expressions got the category right in 11 of 19 [C4] cases, and in 0 of 6 [C5] of the cases tagged hard or tail. That set is the one the prompt was built on, so it shows the shape of the gap between the two, not a held-out accuracy. Instructions planted in the code did not move it: 8 of 8 [C6] injection cases were right in all runs. Where a plain revert of the bad deploy is enough, the model adds nothing, and a spike said so [log-7].
- **A proposed fix, checked, never deployed.** For the code bugs the model also proposes a patch. The screen shows it as “Proposed by Claude” and “not deployed in this demo”, after code checks and a replay with controls: the same events in a different order, a tampered copy that must stay rejected, and PayPal's own answer. 3 of 3 [C13] recorded proposals passed. The same patch with its signature check removed fails the tampered control, and the screen shows that too.
- **Replay needs old signatures to still verify.** 266 of 266 [C10] stored real signatures were still accepted by PayPal's verify call, the oldest being 25.25 h old; older than that is not measured.
- **Resends are earned.** A resend is sent only when the event is in PayPal's events list and PayPal is not retrying it on its own. 27 of 30 [H8] early Ring requests were refused with nothing sent, and a resend sent while PayPal was still retrying reached the shop in 2 of 7 [H10] cases. Another session's ids were refused in 5 of 5 [H11] requests.
- **Guards on cost and abuse.** 1000 scan requests in a flood let 8 of 1000 [L1] through, and 500 further blocked requests used 0 commands [L2] of the database. One plan target was missed: 10 minutes of polling used 102 vs 60 [L3] database commands; in a replay of the page's own polling on an in-memory Redis after the polling change of 2026-10-21, a page left alone used 49 vs 60 [L4] and a page in use 266 vs 60 [L5].

### Design

- **Six recorded stories, each with the same seven chapters.** The order is always: What happened, How it travelled, Why, The replay, The fix, Ring again, The certificate. On a wide screen a path (PayPal, Doorbell, your shop, your books) stays on the right and redraws for each chapter; on a phone the path is a strip pinned to the top and each chapter keeps its headline, one sentence and one piece of evidence, with the rest under More.
- **Honesty is part of the layout.** The bar that says the demo is Sandbox, fictional, test money and planted bugs is on each page. The certificate's stamp is red, amber or green, and green only ever says “Tied on 3/3 of what we can see.” Nothing on a stamp says the shop is in good order. A story that ends open stays red: “2 gaps found · 1 healed · 1 still open.”
- **Words are explained where they first appear.** Terms such as webhook, capture, events list and resend carry a short explanation at their first use on the page, and the sentences that tell a run are fixed templates with the numbers filled in, so the screen cannot say more than the data does.
- **A second reader.** The owner view is a printable page without jargon, for the person who owns the shop and not the code: “Your books match PayPal on 3 of 3 orders.” It says what it cannot do, too: “We can only check what PayPal tells us about. An order that was started but never paid cannot be counted.”

### Potential impact

- **Whose problem.** Developers and small teams who maintain a PayPal checkout, and the owners they report to. The shape of the problem is a shop whose books disagree with PayPal while nothing logged an error: “Nothing crashed and nothing logged an error, so nobody is looking.”
- **What PayPal does and does not do about it.** PayPal retries a failed delivery up to 25 times over 3 days, and a dashboard can resend an event by hand [log-3]. In the Sandbox the retries stopped after 3 tries: 3 of 3 [P1] rejected refund events were delivered 3 times, and then PayPal gave up. A shop that answered 200 gets no retry at all, which is the first story.
- **Disputes.** PayPal's Disputes API listed a dispute made by the Sandbox test call 39 to 104 s [P4] after it was made. A webhook only hears the event types it subscribes to: with no subscribing webhook there were 0 events in 483 s [P5] of watching in the one test, and with a subscribing webhook 4 created, 4 updated [P6] events were listed for 4 disputes. So a shop can be asked for $48 back and never be told; Doorbell finds it by asking PayPal, and says that whether PayPal made an event of its own “cannot be proven from here”.
- **Limits, stated.** The demo is Sandbox only and does not connect to a visitor's own PayPal app or keys, by design. A shop of your own can report its handler's answers to a Doorbell you run yourself, through a signed reporter that the intake accepts only with the shared secret (README, "For a shop of your own"), but that Doorbell does not read the shop's books, so the gap list is still the demo shop's. We have no measured rate for how often this happens in production and we quote none. Nobody pays for it today.

### Innovation

- **A witness, a replay and an honest ending in one tool.** The pieces exist separately: PayPal's dashboard can resend one event by hand. What Doorbell adds is the chain from the shop's books to PayPal's own answer, to the line that dropped the event, to a replay of the real signed events that either confirms the line or does not, to a resend that is attempted only when it can arrive, to a certificate that lists what it could not prove.
- **The model never decides a fact.** Whether there is a gap, whether a row is tied again and what colour the stamp is are decided by code. The model's answer is a category and cited lines, checked three ways before a screen shows it, and “The AI found no changed line that explains this gap.” is a result the product can reach and print.
- **A control that catches a bad fix.** A patch that removes the signature check passes a plain replay, because the shop then books any event it is sent. The tampered-copy control is what rejects it.
- **Said plainly.** The Sandbox behaviours the product is built around were measured, not assumed: for example, a resend of an event that the shop had rejected three times reached the shop in 4 of 37 [H4] sends, against 12 of 22 [H3] when the shop had answered 200.

### Presentation

- **The video** will be under three minutes, with subtitles and text cards only, no music, no logos, and it follows one recorded story from the first screen to the certificate; its script and shot list are kept outside the public repository, and the captions are the product's own sentences.
- **The same words in all three places.** The video, this pack and the product use the same sentences, and the ones quoted in this pack are checked against the product by a test.
- **A judge can repeat it.** Each scene of the video is a link in the three-minute table above and in the stories table.

## 5. What Doorbell cannot prove, and says so

The sentences in curly quotes below are the product's own.

1. **A resend can be accepted and never arrive.** After a resend: “Resend accepted, not delivered”. In full: “PayPal accepted 3 resends and nothing reached your handler within 60 s of the last one. A resend that does not arrive repairs nothing.” The recorded story ends there: “Order #3: Resend accepted, not delivered. The gap stays open.” Its certificate stays red. The measurements behind it: a resend of an event the shop had rejected three times arrived in 4 of 37 [H4] sends; in the trials, 4 of 17 [H2] entries healed and 9 ended with 3 resends accepted and none delivered. The product does not claim a recovery it did not see.
2. **The cause may not be in the code.** “The cause is not proven.” “The gap stands on its own: it does not depend on the AI. Nothing about its cause is claimed.” In the settings story the shop's webhook id had been replaced by the id of another webhook of the same app; the deploy changed only a comment, the AI abstained, and the product did not find the cause. In our recorded answers the model abstained for that case and proposed a category and lines for the 3 code bugs: 3 proposed, 1 abstained [C11]; for one of the three the category was the catch-all one, which the screen presents as “none of its categories fits”.
3. **PayPal's own retry can close a gap.** While PayPal is still retrying an event on its own, Ring again is locked, with the reason: “PayPal is still retrying on its own”. Ringing then could double the delivery, and resends sent in that window reached the shop in 2 of 7 [H10] cases. When PayPal's third try arrives by itself, the row becomes tied without any ring: that happened in the second live run, on the night of 2026-10-20 to 2026-10-21 [log-10]. Since 2026-10-21 the certificate counts such rows apart from the healed ones and says, among what it cannot prove: “1 capture was booked on PayPal's own retry, after the shop did not take the earlier try; this record does not show why, or whether the shop's code changed in between.” The third live run, on 2026-10-21, showed it on the deployed site.
4. **An event can be too new to call missing.** “Too new to call absent: a claim that something is missing waits 6 minutes”. PayPal's events list lags: “PayPal has not listed the refund event yet, usually 1 to 3 minutes after the refund (median about 80 s, up to 163 s measured).” [log-2] In the test of this rule, the first check that called an event absent was at 442.9 s [G7], and none of the 4 earlier checks did.
5. **The standing limits.** The certificate prints, in each run, “Orders that were approved but never captured cannot be counted (PayPal has no list API for them).” and “An event that is not in PayPal's event list cannot be shown to have existed.” and “Transaction Search lags about 97-128 minutes, so the last 2 hours of transactions were not used.” and “This certificate is not signed: anyone could edit it.”
6. **A patch is a proposal.** “Proposed by Claude” and “not deployed in this demo”. The code checks have a stated blind spot: “The checks do not look at comments or leftover code.” The replay says what it proves: “That is a tested result for the whole change, not a proof about any one line.” The demo runs the shop's last good build, never the model's patch.
7. **Disputes.** “Whether PayPal made an event of its own for this dispute cannot be proven from here.” “A Sandbox dispute's response-due date is the one the test call that made it asked for, not a deadline that PayPal's own rules produced.”
8. **Two kinds of AI figures.** 19 of 19 [C1] is the development set, the one the prompt was built on, and is not evidence about unseen code; the held-out figures are 34 of 35 [S1] and 11.67 of 12 [S6], on 35 and 12 cases, with the wide intervals that small counts have [log-9].

## 6. Measured misses and open items

- A plan target was missed: polling for 10 minutes used 102 vs 60 [L3] database commands. In a replay of the page's own polling on an in-memory Redis, after the polling change of 2026-10-21, a page left alone used 49 vs 60 [L4] and a page in use 266 vs 60 [L5], because a page waiting for PayPal's event list polls more often than 60 commands allow. The target was restated on 2026-10-21: the 60 holds for a page left alone; a page in use is bounded by the cost of one poll and by the hourly caps in the code instead.
- When the late payment of the story “A late payment wins” is the event that makes the gap visible, the gap is called 12.5 to 14.8 s [G10] after that payment arrives, and 31 to 60.3 s from the first event the witness heard, because the late payment reached the shop only as a PayPal resend [log-11].
- One of the 12 trials with the shop answering 200 did not heal: "the ring was refused although the state was ready (not_listed)" [H1], which is 11 of 12 healed. Of the 17 entries with the shop rejecting with 401, only 4 of 17 [H2] healed.
- Three items that the second live run left open (from the log, 2026-10-21 [log-10]) were fixed the same day and seen on the deployed site in the third live run: the certificate now says when a gap was booked on PayPal's own retry; the live lane shows the sentence that says why a cause is not proven; the live lane shows an open dispute with the recorded story's sentences. Nothing in the lane makes a dispute, so the dispute story remains a recording.

## 7. Numbers

Each row below is computed from the file in its Source column when `npx tsx scripts/numbers-ledger.ts` runs; the test `scripts/numbers-ledger.test.ts` fails when this table or the stories table differs from that output. A row says what it measures, and a number that is not here is not claimed.

<!-- ledger:start -->
#### Finding the gaps

| ID | Number | What it measures | Source | Measured |
| --- | --- | --- | --- | --- |
| G1 | 12 of 12 in each of 3 scans | Refund gaps found in 3 scans of one 24-capture session in which 12 captures had been refunded | docs/measurements/s3-a3-run1.json: runs[].found, runs[].calls | 2026-10-19 |
| G2 | 0 in each of 3 scans | False alarms in those 3 scans (a capture flagged as a gap that PayPal agrees with) | docs/measurements/s3-a3-run1.json: runs[].falseAlarms | 2026-10-19 |
| G3 | 2.8 to 3.2 s | Server time of a scan of 24 captures (3 scans) | docs/measurements/s3-a3-run1.json: runs[].serverMs | 2026-10-19 |
| G4 | 0 of 5 | Rows marked tied among the rows whose re-query of PayPal failed (the failures were simulated); they stay unverified | docs/measurements/s3-a3-run1.json: mocked | 2026-10-19 |
| G5 | 9 of 9 | Valid trials (3 planted bugs, 3 each) that ended in the expected evidence class; wrong final classes: 0 | docs/measurements/s3-summary.json: a4 | 2026-10-19 |
| G6 | 0 claims | "Missing" claims made before the 6-minute window; 247 scans held one back | docs/measurements/s3-summary.json: a4 | 2026-10-19 |
| G7 | 442.9 s | Time of the first check that called an event absent (the "7 min" check): 1 no report from the shop, 2 no event found, 0 resends used. The 4 earlier checks, the last at 352.5 s, called nothing absent | docs/measurements/s3-absence-run1.json: checks[] | 2026-10-19 † |
| G8 | 13.1 to 14.7 s | Gap called after the witness heard the event, scenario "Dropped after a 200 OK" (3 trials) | docs/measurements/s3-summary.json: a4.finalSecondsAfterD | 2026-10-19 |
| G9 | 3.2 to 3.9 s | Gap called after the witness heard the event, scenario "Rejected with 401 three times" (3 trials) | docs/measurements/s3-summary.json: a4.finalSecondsAfterD | 2026-10-19 |
| G10 | 12.5 to 14.8 s | Gap called after the late payment arrived, scenario "A late payment wins" (3 trials); counted from the first event the witness heard (the refund) it is 31 to 60.3 s | docs/measurements/s3-summary.json: a4.finalSecondsAfterD | 2026-10-19 |

#### Ringing again (resends)

| ID | Number | What it measures | Source | Measured |
| --- | --- | --- | --- | --- |
| H1 | 11 of 12 | Trials that healed when the shop had answered 200 to the event (scenarios "Dropped after a 200 OK" and "A late payment wins", 3 trials each in each of 2 runs); the one that did not ended: "the ring was refused although the state was ready (not_listed)" | docs/measurements/s3-trials-run1.json, s3-trials-run2.json: trials[] (mode, expectedHeal, heal.state, failure) | 2026-10-19 |
| H2 | 4 of 17 | Trial entries that healed when the shop had rejected the event with 401 three times (scenario "Rejected with 401 three times", some trials repeated after a failed attempt); 9 ended with 3 resends accepted by PayPal and none delivered, 4 never reached a ring that was ready within 300 s | docs/measurements/s3-trials-run1.json, s3-trials-run2.json: trials[] | 2026-10-19 |
| H3 | 12 of 22 | Resends that reached the shop when the shop had answered 200 (the control trial included); counted as one arrival per trial that ended in a delivery | docs/measurements/s3-trials-run1.json, s3-trials-run2.json: trials[].heal | 2026-10-19 |
| H4 | 4 of 37 | Resends that reached the shop when the shop had rejected the event with 401 three times | docs/measurements/s3-trials-run1.json, s3-trials-run2.json: trials[].heal | 2026-10-19 |
| H5 | 2.2 to 3.4 s, median 2.5 s | Time from PayPal accepting a resend to the delivery reaching the shop (15 healed rows) | docs/measurements/s3-summary.json: a5.arrivalSecondsAfter202 | 2026-10-19 |
| H6 | median 89.1 s | Time from the gap being called to the row being tied again (15 healed rows; range 6.9 to 287.2 s); resends are about 60 s apart, so rows that needed 2 or 3 resends take minutes | docs/measurements/s3-summary.json: a5.timeFromDetectionToTiedSeconds | 2026-10-19 |
| H7 | median 66.5 s | Time from pressing Ring again to the row being tied again (same 15 rows; range 5.1 to 131.7 s) | docs/measurements/s3-summary.json: a5.timeFromRingToTiedSeconds | 2026-10-19 |
| H8 | 27 of 30 | Early Ring requests (made before the row was ready) that were refused with nothing sent because PayPal had not listed the event yet; the other 3 found the event already listed and sent | docs/measurements/s3-summary.json: a5.earlyRings, earlyRingsNotListed, earlyRingsThatSentSomething | 2026-10-19 |
| H9 | 1 of 1 | Control without the code fix: the resend arrived and the row stayed open, as it should (a resend heals nothing if the shop still drops the event) | docs/measurements/s3-summary.json: a5.controlNoFix | 2026-10-19 |
| H10 | 2 of 7 | Resends sent while PayPal was still retrying the event on its own: how many of the accepted resends reached the shop (the product locks Ring again in that window) | docs/measurements/s3-summary.json: a5.resendWhilePayPalRetries | 2026-10-19 |
| H11 | 5 of 5 | Requests with another session's capture, refund, order or event ids that were refused with 403; resends used by either session: 0 | docs/measurements/s3-cross-run1.json: statuses, resendsUsedA, resendsUsedB | 2026-10-19 † |

#### The sealed evaluation: held-out sets, run on 2026-10-26 after the seal commit (docs/planning/eval/SEAL.md)

| ID | Number | What it measures | Source | Measured |
| --- | --- | --- | --- | --- |
| S1 | 34 of 35 | H-a cases (written in a separate session) where the model named the right category, averaged over 3 runs per case (34 right in all runs); category and cited line: 33 of 35 | eval/runs/sealed-ha/results+b2.json: perCase[].runs[].cat, .both | 2026-10-26 |
| S2 | 15 of 35 | The same H-a cases the frozen regular-expression baseline (B1, no AI) gets right | eval/runs/sealed-ha/results+b2.json: perCase[].B1.score.cat | 2026-10-26 |
| S3 | 21 of 35 | The same H-a cases the sealed checklist baseline (B2, written in a separate session, run as the program it is) gets right | eval/runs/sealed-ha/results+b2.json: perCase[].B2.score.cat | 2026-10-26 |
| S4 | 14 of 14 | H-a cases tagged keyword-free (the diff carries no category word): the model; the baselines on the same cases: B1 4 of 14, B2 10 of 14 | eval/runs/sealed-ha/results+b2.json: perCase[].tags.mix, runs[].cat, B1, B2 | 2026-10-26 |
| S5 | 1 of 35 | H-a cases where an answer passed both code checks and named the wrong category (confidently wrong), averaged over runs; the pre-registered limit for the top tier is 1 | eval/runs/sealed-ha/results+b2.json: perCase[].runs[].status, .cat | 2026-10-26 |
| S6 | 11.67 of 12 | H-b cases (rebuilt from real public fix commits, the fixer's comments removed) with the right category, averaged over runs; the 6 commits with a Claude co-author trailer 5.67 of 6, the other 6 6 of 6; H-b covers 3 of the 8 categories | eval/runs/sealed-hb-nocomment/results.json: perCase[].runs[].cat, tags.ai_attributed_commit | 2026-10-26 |
| S7 | 12 of 12 | The obfuscated twin of H-b (identifiers renamed by the sealed script, comments removed): the contamination check; a result more than 15 points under S6 would have replaced it as the headline | eval/runs/sealed-hb-obfuscated/results.json: perCase[].runs[].cat | 2026-10-26 |
| S8 | 11.67 of 12 | H-b with the fixer's comments left in: a secondary number that decides nothing | eval/runs/sealed-hb-original/results.json: perCase[].runs[].cat | 2026-10-26 |
| S9 | $3.71 | Model spend of the four sealed runs together | eval/runs/sealed-ha/results.json, eval/runs/sealed-hb-nocomment/results.json, eval/runs/sealed-hb-obfuscated/results.json, eval/runs/sealed-hb-original/results.json: summary.spendUsd | 2026-10-26 |

#### The cause step and the replay (the AI proposes, code checks)

| ID | Number | What it measures | Source | Measured |
| --- | --- | --- | --- | --- |
| C1 | 19 of 19 | Development-set cases answered correctly in all 3 runs (57 answers: 54 proposed a cause, 3 abstained). This is the set the prompt was built on, not a held-out set | eval/runs/dev-final-2/results.json: summary, perCase[].runs[].both | 2026-10-19 |
| C2 | 0 wrong | Answers shown that were wrong on the development set | eval/runs/dev-final-2/results.json: summary.shownWrong | 2026-10-19 |
| C3 | 3 of 3 | Development-set cases tagged "tail" that were right in all runs; the 3 abstentions are the 3 runs of the one case whose label is "cause not in the diff" | eval/runs/dev-final-2/results.json: perCase[].tags.tail | 2026-10-19 |
| C4 | 11 of 19 | Cases a plain-code baseline (regular expressions, no AI) gets the cause category right; category and line: 10 of 19 | eval/runs/dev-final-2/results.json: summary.B1 | 2026-10-19 |
| C5 | 0 of 6 | Development-set cases tagged "hard" or "tail" that the same baseline gets right | eval/runs/dev-final-2/results.json: perCase[].tags, perCase[].B1.score.cat | 2026-10-19 |
| C6 | 8 of 8 | Injection cases (instructions planted in comments of the code) answered correctly in all 3 runs, 0 wrong shown | eval/runs/a8-injection-final/results.json: summary | 2026-10-19 |
| C7 | $0.0100 | Cost per cause call on the development set ($0.57 for 57 calls) | eval/runs/dev-final-2/results.json: summary.spendUsd | 2026-10-19 |
| C8 | 9 of 9 | Replays of stored real signed events that confirmed the cause (3 planted bugs, 3 each): the bad build and the good build answered as the cause predicts | docs/measurements/s4-a25-run1.json: summary.confirmed | 2026-10-19 |
| C9 | 6 of 6 | Replays whose events were older than the replay window (4 h at the time) that were shown as recorded results, with 0 verify calls made | docs/measurements/s4-a25-run1.json: summary.outsideWindow | 2026-10-19 |
| C10 | 266 of 266 | Stored real signatures that PayPal's verify call still accepted, the oldest 25.25 h old (older than that is not measured) | docs/measurements/s5-reverify-24h.json: result, age | 2026-10-20 |
| C11 | 3 proposed, 1 abstained | Recorded cause answers behind the stories: 3 code bugs got a category and cited lines; the settings bug (a wrong webhook id, no changed code line) got no cause | docs/measurements/s4-record-causes.json, s4-record-causes-wrong_webhook_id_setting.json: results | 2026-10-19 and 2026-10-20 |
| C12 | $0.0251 | Cost of the 4 recorded cause calls | docs/measurements/s4-record-causes.json, s4-record-causes-wrong_webhook_id_setting.json: usd | 2026-10-19 and 2026-10-20 |
| C13 | 3 of 3 | Recorded patch proposals, one per planted code bug, that passed the code checks and the replay; 0 live verify calls were made (96 answered from stored results); model cost $0.0261 | docs/measurements/fix-record-2026-10-20.json: modes[].result.verdict, verify, spentUsdAllRuns | 2026-10-20 |

#### Guards on cost and abuse

| ID | Number | What it measures | Source | Measured |
| --- | --- | --- | --- | --- |
| L1 | 8 of 1000 | A flood of 1000 scan requests: requests that got through to the work; server-side Redis commands used by the whole flood: 26 | docs/measurements/s4-a13-run1.json: flood_scan | 2026-10-19 |
| L2 | 0 commands | Extra Redis commands used by 500 further requests that were blocked | docs/measurements/s4-a13-run1.json: blockedRequests | 2026-10-19 |
| L3 | 102 vs 60 | A miss: Redis commands used by 10 minutes of a page polling (server count) against the 60 the plan allowed | docs/measurements/s5-poll-cost.json: tenMinutes | 2026-10-19 |
| L4 | 49 vs 60 | After the polling change of 2026-10-21: Redis commands in 10 minutes of a page that is opened and left alone (the lane's own cadence replayed, each poll counted on an in-memory Redis running the real store code); inside the plan's 60 | docs/measurements/s6-a13-redis-2026-10-21.json: tenMinutes.idle.after, perPoll | 2026-10-21 |
| L5 | 266 vs 60 | Still a miss after that change: the same count for a page in use for 10 minutes (an order, a planted bug, a refund, the fix and a ring, on a modelled timeline of a visit) | docs/measurements/s6-a13-redis-2026-10-21.json: tenMinutes.active.after | 2026-10-21 |

#### What PayPal's Sandbox did

| ID | Number | What it measures | Source | Measured |
| --- | --- | --- | --- | --- |
| P1 | 3 of 3 | Refund events rejected with 401 that PayPal delivered 3 times and then gave up (3 trials); the second try came 28 to 35 s after the first, the third 155 to 165 s after the first | docs/measurements/s2-modes-run1.json: rows with mode bad_body, observed.answers, observed.attemptSecondsAfterFirst | 2026-10-19 † |
| P2 | 10 of 10 | Test events of the two Sandbox apps that showed up only under the app that made them, at the witness and in PayPal's event list | docs/measurements/s2-cross-app-run1.result.json: rows[] | 2026-10-19 |
| P3 | 25.2 s vs 129 s | One order (n = 1): seconds until the witness heard the payment event, against seconds until PayPal's event list showed it | docs/measurements/disputes-probe-2026-10-20.json: steps.order | 2026-10-20 |
| P4 | 39 to 104 s | Seconds until PayPal's Disputes API listed a dispute made by the Sandbox test call (5 disputes) | docs/measurements/disputes-probe-2026-10-20.json: steps.c_chargeback, c2_more_trials, e2_dispute_with_no_subscribing_webhook | 2026-10-20 |
| P5 | 0 events in 483 s | A dispute made while no webhook subscribed to dispute events (n = 1): dispute events PayPal listed while it was watched | docs/measurements/disputes-probe-2026-10-20.json: steps.e2_dispute_with_no_subscribing_webhook | 2026-10-20 |
| P6 | 4 created, 4 updated | Dispute events PayPal listed for 4 disputes made while a webhook did subscribe to dispute events | docs/measurements/disputes-probe-2026-10-20.json: steps.f_event_type_tally | 2026-10-20 |

† The file stores no date; the date is the one the log gives for the step that measured it.
<!-- ledger:end -->

### The six recorded stories

<!-- stories:start -->
| On screen | Link | What the run shows | Recorded (UTC) | File |
| --- | --- | --- | --- | --- |
| Dropped after a 200 OK | `/?s=refund_never_booked` | A refund PayPal made never reached the books | 2026-10-20 10:43 UTC | `fixtures/recorded-run/refund_never_booked.json` |
| A late payment wins | `/?s=late_payment_overwrites` | A late payment message overwrote a refund | 2026-10-20 10:45 UTC | `fixtures/recorded-run/late_payment_overwrites.json` |
| Rejected with 401 three times | `/?s=signature_rejected` | The shop rejected PayPal's signed messages | 2026-10-20 11:57 UTC | `fixtures/recorded-run/signature_rejected.json` |
| Ring again, one never arrived | `/?s=resend_not_delivered` | PayPal accepted a resend and never delivered it | 2026-10-19 12:29 UTC | `fixtures/recorded-run/resend_not_delivered.json` |
| Rejected after a settings change | `/?s=cause_not_in_code` | The shop rejected PayPal's signed messages after a deploy that only changed a comment | 2026-10-20 09:12 UTC | `fixtures/recorded-run/cause_not_in_code.json` |
| A dispute nobody heard | `/?s=dispute_never_heard` | A customer's bank disputed an order at PayPal and the shop was never told | 2026-10-20 10:42 UTC | `fixtures/recorded-run/dispute_never_heard.json` |
<!-- stories:end -->

### From the log, not from a file

These are not in any file of this repository. Each is from the build log with its date. They are quoted as the log has them and are not checked by a test.

1. **[log-1]** The receiver, 2026-10-19: 69 of 69 real deliveries verified, 15 of 15 forged deliveries rejected, the same transmission id delivered 3 times was processed once, the 95th-percentile response time was 2.68 s, and 200 forged deliveries in a minute led to 60 verify calls.
2. **[log-2]** PayPal's events list lag in the Sandbox: median 81 s, up to 163 s (the product text says “median about 80 s, up to 163 s”). Measured in the first feasibility probe, early on 2026-10-19, before the build; not in a measurement file.
3. **[log-3]** PayPal's documentation, checked 2026-10-20: a failed delivery is retried up to 25 times over 3 days and then marked failed; a dashboard can resend an event by hand; the dashboard keeps events for 30 days.
4. **[log-4]** Containment checks, 2026-10-19: 10 of 10 decoy comments ("the bug is here") were rejected by the line check and no marker reached the page; 20 of 20 forced model failures ended as "not diagnosed" and left the gap list as it was.
5. **[log-5]** Resends accepted before PayPal listed the event, 2026-10-19: 2 of 5 never arrived, which is why a resend waits for the listing.
6. **[log-6]** The first end-to-end pass of the live lane on the real Sandbox, 2026-10-20, 12:44 to 12:49 UTC: the first Ring again was refused because PayPal had not yet listed the event; the second, about 3 minutes later, arrived 2.5 s after PayPal accepted it, and the books and the certificate followed.
7. **[log-7]** A spike on proposed fixes, 2026-10-20, run outside this repository: a whole revert of the bad deploy fixed 13 of 13 simple regressions, so the model adds nothing there; on deploys that mix a bug with other changes the model's patches passed 33 of 36 and a whole revert 0 of 12; 24 of 25 cases passed on the first attempt; one patch silently removed a feature, which is why a person reads each proposed patch before it ships; model cost $0.95.
8. **[log-8]** A spike on replay age, 2026-10-20: a stored real signature still verified at 29.7 h, beyond the 25.25 h in the ledger. The replay window is set to 24 h.
9. **[log-9]** The held-out evaluation: three sets were sealed by SHA-256 on 2026-10-19 before any run (H-a, 36 cases written in a separate session; H-b, 12 cases rebuilt from real public fix commits; B2, a checklist baseline), and 6 of the 12 fix commits in H-b carry an AI co-author trailer and are reported separately (registered before the run). On 2026-10-26, before the run: a separate Claude agent audited the 36 H-a labels (35 right, 1 ambiguous and excluded, 0 wrong; no person audited them), the sets were converted into the harness's file shape with the code byte-identical and sealed again as derived sets, and the obfuscated twin was built from the two sealed scripts; all of it is in SEAL.md, committed and pushed to the public repository before the first model call. The run followed the same evening; its rows are S1 to S9 and its verdict, from the pre-registered script, is GREEN. The 95% intervals on 35 and 12 cases are wide: about 86 to 99 percent for S1 and 72 to 100 percent for S6.
10. **[log-10]** Open items, 2026-10-21: in the second live run a PayPal retry closed a gap with no ring, and the Ring again chapter then stopped updating and the certificate said only that 1 of 1 captures was tied; the sentence that says why a cause is not proven does not show in the live lane; the live lane does not show a dispute yet, only the recorded story does.
11. **[log-11]** The late-payment trials, 2026-10-19: PayPal could deliver the late payment only as a resend, which is why the count from the first event the witness heard is longer than the count from the late payment.
12. **[log-12]** Recorded screens made 0 network requests in the measurement of the first design release, 2026-10-20 (the log's "recorded screen: network 0"); the page's own note says the same: "Nothing is sent to PayPal."
