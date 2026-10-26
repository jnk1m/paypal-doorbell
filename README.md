# Doorbell

Webhook gap finder for PayPal.

> Sandbox demo · fictional shop · PayPal test money · bugs are planted by us

Doorbell finds the payments, refunds and disputes that PayPal knows about and a shop's books do not. For each one it says what it can prove and what it cannot, has an AI point at the changed line of the shop's code that explains it, checks that pointer in plain code, then replays real signed events through the good and the bad build to test the change as a whole, asks PayPal to send the event again only when PayPal lists it, and ends in a certificate that prints what it cannot prove first.

Today Doorbell watches only the demo shop in this repository; for a shop of your own there is no reporter yet.

Hosted demo, no sign-in and no API key: https://paypal-doorbell.vercel.app/

Video (2:45, captions only, no voice): https://youtu.be/julp0a21e9A

For judges: the five criteria, each with its evidence, are in [the judge pack](docs/judge-pack.md), section 4.

## Why

A webhook is a message that PayPal posts to your server's address when something happens, such as a refund. When the shop never hears it, or hears it and never saves it, there is nothing to alert on: “Nothing crashed and nothing logged an error, so nobody is looking.”

I have been on the other side of this. At a shop I worked on, I once tightened the webhook handler's signature check. For a while after that, the payment provider's cancellation messages were rejected, and nothing logged an error. The books stayed wrong until someone compared them with the provider's records. Fixing it was easy. The question after it was not: how do you know it is fixed, and what else was dropped?

- **Who it is for.** Anyone who maintains a PayPal checkout and has no alert when a webhook never arrives or is dropped after a 200 OK. We quote no rate for how often this happens in production.
- **What is new.** A manual resend from PayPal's dashboard sends one event you already know about. Doorbell finds the gap, says why, proves the fix on real signed events, and resends only when the resend can arrive.

## What it does

1. A second webhook of its own, the witness, receives PayPal's deliveries, checks each signature with PayPal's `verify-webhook-signature` call, and stores each attempt.
2. A scan asks PayPal again, by id, what each capture is, and compares PayPal's answer with the shop's books. A row where the two differ is a gap. Code decides this; no model is involved.
3. Each row gets one of five evidence classes: the handler said OK but the books did not change; the handler turned the delivery away; the handler never reported it; no event found anywhere; or not provable yet. A claim that something is missing waits: “Too new to call absent: a claim that something is missing waits 6 minutes”.
4. For a gap that a code change explains, an AI is given the diff between the last good and the first bad build. It returns one of eight categories and the changed lines it cites, and no sentence of its own reaches the screen. Plain code checks the lines, then a replay sends stored real signed events through the good build and the bad build and compares the answers and the books.
5. For the code bugs the AI also proposes a patch. It is checked, replayed with controls, and shown as “Proposed by Claude” and “not deployed in this demo”.
6. Ring again asks PayPal to send the event again, only when PayPal's events list has it and PayPal is not still retrying on its own. A row is tied again only when the shop's books changed and now match PayPal's own answer.
7. The certificate counts what was checked and prints what Doorbell cannot prove first. A second page, the owner view, says the findings in plain sentences, with the two limits an owner needs. Neither is signed.

## Try it in 3 minutes

The pages below are on the hosted site, https://paypal-doorbell.vercel.app, and play back runs that were recorded on PayPal's Sandbox. Nothing here calls PayPal, the database or the AI. The same steps, with the figures behind them, are in [the judge pack](docs/judge-pack.md). If a link opens the lead story, pick the story in the scenario menu: the server sends the same page for each `?s=` value and the story is chosen in the browser.

| # | Open | What you will see | Time |
| --- | --- | --- | --- |
| 1 | [paypal-doorbell.vercel.app](https://paypal-doorbell.vercel.app/) | The headline “PayPal refunded $48.00. Your books still say paid.” and under it “No error anywhere.” A bar that never leaves the screen: “Sandbox demo · fictional shop · PayPal test money · bugs are planted by us”. | 20 s |
| 2 | The same page: the tabs at the top (What happened, How it travelled, Why, The replay, The fix), or scroll | “Each hop said OK. The books never changed.” Then the AI's pointer at two changed lines, with two plain-code checks. Then “Same messages, two builds. Only one saves them.” Then “Fixing the code does not rewrite the books. Only another delivery of the same event can.” | 60 s |
| 3 | The "Ring again" tab, then the Ring again button | A stored real resend plays back under the note “A replay of the real resend from Oct 20, 2026, sped up. Nothing is sent to PayPal.” It ends with “The books now say refunded.” and the certificate: “2 gaps found · 2 healed · 0 still open.” | 30 s |
| 4 | The scenario menu, then "Ring again, one never arrived" ([`/?s=resend_not_delivered`](https://paypal-doorbell.vercel.app/?s=resend_not_delivered)), then Ring again | An ending that does not heal: “Order #2 now says refunded. Order #3 is still open.” and “Order #3: Resend accepted, not delivered. The gap stays open.” | 30 s |
| 5 | "Rejected after a settings change" ([`/?s=cause_not_in_code`](https://paypal-doorbell.vercel.app/?s=cause_not_in_code)), the Why tab | “The cause is not proven.” “The AI found no changed line that explains this gap.” | 15 s |
| 6 | "A dispute nobody heard" ([`/?s=dispute_never_heard`](https://paypal-doorbell.vercel.app/?s=dispute_never_heard)) | “PayPal lists a $48.00 dispute on order #2. Your books have none.” and “No webhook of this app asks for dispute events.” | 15 s |
| 7 | [`/certificate?s=refund_never_booked`](https://paypal-doorbell.vercel.app/certificate?s=refund_never_booked) (the link "Open the owner view") | A printable page in plain sentences: “We checked 3 of your 3 orders against PayPal's own records.” and “This page is not signed. Anyone could edit it, so treat it as a report, not a receipt.” | 10 s |

The six recorded stories, each also at `/certificate?s=<id>` for its owner view:

- [`/?s=refund_never_booked`](https://paypal-doorbell.vercel.app/?s=refund_never_booked): Dropped after a 200 OK
- [`/?s=late_payment_overwrites`](https://paypal-doorbell.vercel.app/?s=late_payment_overwrites): A late payment wins
- [`/?s=signature_rejected`](https://paypal-doorbell.vercel.app/?s=signature_rejected): Rejected with 401 three times
- [`/?s=resend_not_delivered`](https://paypal-doorbell.vercel.app/?s=resend_not_delivered): Ring again, one never arrived
- [`/?s=cause_not_in_code`](https://paypal-doorbell.vercel.app/?s=cause_not_in_code): Rejected after a settings change
- [`/?s=dispute_never_heard`](https://paypal-doorbell.vercel.app/?s=dispute_never_heard): A dispute nobody heard

**The live lane**, [`/live`](https://paypal-doorbell.vercel.app/live), runs a new order, a planted bug and a refund against PayPal's Sandbox. It needs a judge token, which the Devpost submission gives. The token is typed into the page's text box, stays in that browser tab and is sent only to this site; it is never part of a URL. The page says what it costs in time: “A live run against PayPal's Sandbox; it takes a few minutes, because PayPal delivers and lists events on its own clock.” When the live lane is at its limit or unavailable, it plays the recorded run instead and says so.

## What is real, planted, recorded, live, and not run yet

| Word | What it means here |
| --- | --- |
| Real | The six stories were run on the deployed shop against PayPal's Sandbox, and the PayPal ids on screen (event, capture, order) are PayPal's. The money is Sandbox test money and the shop, Maple Mug, is fictional. |
| Planted | Each bug is one we put into the shop's webhook handler (`handlers/*.ts`) or its settings, and the screen says so next to it. Doorbell did not find them in anyone's real shop. In the settings story: “That wrong ID was planted by us, and Doorbell did not find it.” The dispute in its story was made by PayPal's Sandbox-only test call for chargebacks, not by a customer. |
| Recorded | On the recorded pages Ring again plays back the stored result of a real resend, with its long waits cut, and the page says so: “Nothing is sent to PayPal.” The AI's answers are stored recordings: “The answer is a stored recording; this page makes no model call.” |
| Live | The live lane, with the judge token. On the hosted site the cause step reads a stored answer first; a live model call is allowed only behind an hourly limit and a money budget, and anything that fails ends as a "not diagnosed" result instead of a guess. |
| Held-out | The AI step was evaluated on 2026-10-26 on sets sealed by hash before any run: 34 of 35 [S1] cases right on the set written in a separate session, 11.67 of 12 [S6] on cases rebuilt from real public fix commits. The development-set figures below are labelled as such. |

## What Doorbell cannot prove

The sentences in curly quotes are the product's own, and a test checks that the product still says them.

- **A resend can be accepted and never arrive.** “Resend accepted, not delivered”. In full: “PayPal accepted 3 resends and nothing reached your handler within 60 s of the last one. A resend that does not arrive repairs nothing.” The recorded story `resend_not_delivered` ends there and its certificate stays red. A resend of an event the shop had rejected three times reached the shop in 4 of 37 [H4] sends, against 12 of 22 [H3] when the shop had answered 200.
- **The cause may not be in the code.** “The cause is not proven.” “The gap stands on its own: it does not depend on the AI. Nothing about its cause is claimed.” In the settings story the deploy changed only a comment, the AI abstained, and the product did not find the cause.
- **An event can be too new to call missing.** “PayPal has not listed the refund event yet, usually 1 to 3 minutes after the refund (median about 80 s, up to 163 s measured).” In the test of the 6-minute rule there were 0 claims [G6] made before the window.
- **PayPal's own retry can close a gap.** While PayPal is still retrying, Ring again is locked: “PayPal is still retrying on its own”. When a retry arrives by itself the row becomes tied without any ring, and the certificate says so: “1 capture was booked on PayPal's own retry, after the shop did not take the earlier try; this record does not show why, or whether the shop's code changed in between.”
- **A patch is a proposal.** The demo runs the shop's last good build, never the model's patch. The checks have a stated blind spot: “The checks do not look at comments or leftover code.” The replay says what it proves: “That is a tested result for the whole change, not a proof about any one line.”
- **Disputes.** “Whether PayPal made an event of its own for this dispute cannot be proven from here.” “A Sandbox dispute's response-due date is the one the test call that made it asked for, not a deadline that PayPal's own rules produced.”
- **The standing limits**, printed on each certificate: “Orders that were approved but never captured cannot be counted (PayPal has no list API for them).” “An event that is not in PayPal's event list cannot be shown to have existed.” “Transaction Search lags about 97-128 minutes, so the last 2 hours of transactions were not used.” “This certificate is not signed: anyone could edit it.”
- **The witness looks forward.** It only hears deliveries made after it was registered. An earlier incident can be looked at only through the by-id re-query and the events list.
- **Why PayPal did not deliver is not known.** When PayPal's events list has an event that the witness never heard, Doorbell reports the miss and no cause: it cannot see PayPal's side.
- **Not measured.** The demo is Sandbox only. We have no measured rate for how often this happens in production and we quote none. PayPal's documentation describes retries for longer in production; in 3 of 3 [P1] trials PayPal delivered a rejected refund event 3 times and then gave up.

## How it works

```
PayPal ── signed webhook ──▶ witness (app/api/witness): verify signature, store each attempt
   ├── the same events ───▶ the shop's webhook (app/api/shop/webhook) ─▶ handlers/*.ts ─▶ books
   │                          reporter: "received", then "responded <status>"
   ├── GET capture by id ┐
   ├── events list       ├─▶ scan (lib/gaps): classify each row, evidence class + flag
   └── subscriptions     ┘
gap ─▶ cause (lib/cause): AI picks category + changed lines ─▶ code checks ─▶ replay on stored signed events
    ─▶ fix (lib/fix, offline): proposed patch ─▶ code checks ─▶ replay with controls (the patch is never deployed)
    ─▶ ring (lib/gaps): PayPal resend if listed ─▶ arrival seen ─▶ books re-read ─▶ tied, or still open
all of it ─▶ one RunSnapshot (lib/run/snapshot.ts) ─▶ the screens and the certificate (lib/cert)
```

- **PayPal is the subject, not a button.** The product uses a webhook of its own for the witness and `verify-webhook-signature` on each delivery; the webhook management calls, to read which event types the shop's webhook subscribes to; the events list; the resend call; the Orders and payments calls (capture read, refund) for the demo shop, the refund through PayPal's Agent Toolkit; and the Disputes API, read only.
- **Receiver.** The witness checks a delivery's certificate URL host before it asks PayPal to verify, writes each attempt (a retry reuses the transmission id), and processes an event once, only after verification succeeded. A forged delivery gets 401 and changes nothing. If PayPal's verify call itself fails, the delivery is kept in quarantine, answered 200, and verified again later.
- **Scan.** By-id reads run concurrently under a deadline; a read that fails, or does not finish, makes its row unverified, not tied (0 of 5 [G4] simulated failures were marked tied). In three scans of a 24-capture session in which the shop had dropped 12 refunds, Doorbell found 12 of 12 in each of 3 scans [G1]. False alarms: 0 in each of 3 scans [G2]. Each scan took 2.8 to 3.2 s [G3] of server time.
- **Classify.** `lib/gaps/classify.ts` is a pure function of the evidence: the witness, PayPal's events list, the shop's reporter and its webhook subscription. In 9 of 9 [G5] trials of three planted bugs the class was the expected one. The 6-minute window applies only to claims of absence.
- **Cause.** `lib/cause`: input hygiene, one model call, then two checks (the cited line must be a changed code line, not a comment or a blank; the category must fit what the shop answered), then the replay, which confirmed the cause in 9 of 9 [C8] replays. A confirmation needs the replay and the category to agree. These are the three planted bugs the replay modes were built for, so 9 of 9 [C8] is a result on the demo shop, not on unseen code. A plain revert fixes all three, so the demo does not show the model doing better than a revert.
- **Fix.** `lib/fix` runs offline, from a recording script. The deployed site imports only its stored results, types and rules (`lib/fix/recorded.ts`, `lib/fix/types.ts`, `lib/fix/rules.ts`); the model call, the checks and the replay sandbox are never imported by deployed code, and `lib/fix/recorded.test.ts` checks that import graph. The offline run checks the edits, replays the patched handler on real signed deliveries with controls (the same events in another order, a tampered copy that must stay rejected, PayPal's own answer), and a patch is shown only when all of it passes. 3 of 3 [C13] recorded proposals passed, one per planted bug. The same patch with its signature check removed fails the tampered control, and the screen shows that too.
- **Ring.** `lib/gaps/heal.ts`: after an accepted resend, the arrival is looked for at the shop for a limited time, with a capped number of further resends.
- **Certificate.** `lib/cert/templates.ts` is a template plus numbers counted from the scan; no sentence in it is built from a string that came from PayPal, from the shop or from a model. Green only ever says “Tied on 3/3 of what we can see.”
- **Recorded runs.** Each is a short list of RunSnapshots captured by `scripts/record-run.ts` from the deployed shop against the Sandbox, and imported as JSON (`fixtures/recorded-run`). The recorded pages read no environment variable and make no network or database call; `lib/run/recorded.test.ts` runs them with an emptied environment and a `fetch` that throws.
- **Guards.** 1000 scan requests in a flood let 8 of 1000 [L1] through, and 500 further blocked requests used 0 commands [L2] of the database. Rate limits are hourly windows with a memory pre-filter, and session ids are checked: another session's ids were refused in 5 of 5 [H11] requests.

## The AI step

- **Two kinds of model call**, both to Claude through the Anthropic API. The cause call (`lib/cause`) reads a stored answer first on the hosted site, and a live call is allowed only behind a gate (below). The fix call (`lib/fix`) never runs on the hosted site: its answers were recorded offline and each patch was read by a person before it was allowed on a screen.
- **What goes in.** A fixed sentence for the symptom class that code computed from the shop's delivery records, the diff between the last good and the first bad build, and the files of the first bad build. No free text from a visitor (shop name, order note, customer name) is part of the input: the code that builds it has no parameter that could carry one.
- **What comes out.** One of eight categories, a file, ids of changed lines, a hunk id. The model is not asked for an explanation, and the sentence on the card comes from a template per category. The model's answer reaches a screen only after both checks pass. The page's AI receipt line names the model and says whether the answer is a stored recording or a live call.
- **Input hygiene.** One normalization is used for what the model reads, what the checks compare and what the screen prints: Unicode normalization, removal of invisible format characters, rejection of binary input, disarming of look-alikes of the prompt's own delimiters, replacement of secret-shaped strings, size limits. A cited line that mixes look-alike letters from another alphabet is refused as evidence, and non-ASCII characters are printed escaped. The prompt tells the model that the diff and the files are untrusted data.
- **Frozen for the evaluation.** `eval/harness/FREEZE.json` holds the prompt version and hash, the output schema hash, the call parameters, the product source files that make the call, and the package versions. The harness imports the product's own cause module, so a harness number is a product number.
- **It can say "no".** If no changed line explains the gap, the answer is “The cause is not proven.” Any failure (timeout, unreadable output, a refused call, no key, no recording, a refused input, a spent budget) ends as "Not diagnosed." with a fixed reason; the gap list does not change.
- **Cost guard.** A live call must pass a gate: an hourly limit and a money budget per UTC day that reserves the call's worst case before it is made. When the gate says no, no call is made and the stored answer is shown.
- **Why a model at all.** On the development set the model was right in 19 of 19 [C1] cases in all 3 runs, with 0 wrong [C2] answers shown; a plain-code baseline with regular expressions got the category right in 11 of 19 [C4] cases, and in 0 of 6 [C5] of the cases tagged hard or tail. Outside those hard and tail cases the baseline mostly ties with the model, so the model's lead is in exactly the cases a regular expression cannot read. That set is the one the prompt was built on, so it shows the shape of the gap between the two, not a held-out accuracy. Instructions planted in the code did not move it: 8 of 8 [C6] injection cases were right in all runs. Where a plain revert of the bad deploy is enough, the model adds nothing; an offline spike said so (judge pack, section 4).
- **Accuracy on the sealed sets (run 2026-10-26).** On the held-out set written in a separate session, the model named the right category in 34 of 35 [S1] cases (mean over 3 runs; 33 of 35 with the cited line too), against 15 of 35 [S2] for the regular-expression baseline and 21 of 35 [S3] for the sealed checklist baseline. On the 14 cases whose diff carries no category word it was 14 of 14 [S4], against 4 and 10 for the two baselines. One answer was confidently wrong [S5]: a request filter that the model called a moved endpoint. On the 12 cases rebuilt from real public fix commits it was 11.67 of 12 [S6] with the fixer's comments removed, and 12 of 12 [S7] on an obfuscated twin, so nothing suggests the model knew those commits; the 6 commits with a Claude co-author trailer scored 5.67 of 6, the other 6 scored 6 of 6. One of the 36 held-out labels was excluded before the run as ambiguous, and the sets' file shapes had to be converted for the harness; both are recorded in SEAL.md. The pre-registered three-tier verdict is GREEN. Model spend for the four runs: $3.71 [S9]. These numbers come from 35 and 12 cases, so the 95% intervals are wide (about 86 to 99 percent and 72 to 100 percent).

## Run it yourself

You need Node 20 or newer. With no key and no database, `npm install` and `npm run dev` show the recorded stories at http://localhost:3000/?s=refund_never_booked (the story is picked in the browser, from the scenario menu or the `?s=` value). The recorded pages and `npm test` need neither a key nor a database. The witness, the shop and the live lane need a PayPal developer account with one Sandbox business account and one Sandbox app, and an Upstash Redis database. An Anthropic API key is needed only for a live diagnosis or to record new answers; the hosted default reads the recorded answers in `fixtures/recordings`.

`.env.example` lists the variables; fill in your own values and keep them out of git. Names: `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` (the one Sandbox app the code runs as), `PAYPAL_WITNESS_WEBHOOK_ID`, `PAYPAL_SHOP_WEBHOOK_ID`, `PAYPAL_WITNESS_DEV_WEBHOOK_ID` (optional), `DOORBELL_LIVE_TOKEN` (any secret you choose; the live shop is closed unless it is set), `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `ANTHROPIC_API_KEY`. `PAYPAL_DEMO_CLIENT_ID` and `PAYPAL_DEMO_CLIENT_SECRET` are read only by scripts that act as a second, "demo" Sandbox app (`scripts/env.ts`); we keep a development app and a demo app apart, and you need not. The PayPal client refuses any base URL but PayPal's Sandbox.

```
npm install
npm run dev        # builds the diffs the AI step reads, then starts Next.js
npm test           # unit tests; files that need the Sandbox or Redis are left out (npm run test:redis)
npm run typecheck
```

PayPal posts webhooks to a public HTTPS address, so for the live parts the order is: (1) set the PayPal keys, the two Redis variables and `DOORBELL_LIVE_TOKEN`, and deploy the app (we use Vercel) or tunnel to it; (2) register two webhooks on your Sandbox app with `scripts/webhook.ts` (the usage lines at its top show `list`, `register` and `delete`, and `register` prints the id): the witness at `/api/witness` and the shop's at `/api/shop/webhook`, which subscribes to the two capture event types named in the comment above `PAYPAL_SHOP_WEBHOOK_ID` in `.env.example` (`--types`); (3) put the two ids in `PAYPAL_WITNESS_WEBHOOK_ID` and `PAYPAL_SHOP_WEBHOOK_ID`; (4) redeploy or restart so they are read. The hosted demo's webhooks are recorded in `fixtures/demo-webhooks.frozen.json`; once that file exists, `scripts/webhook.ts --app demo` refuses to change them and `scripts/check-webhooks.ts` compares the live webhooks with the record, because registering or changing a webhook was followed, in our early runs, by a stretch in which some events were not delivered and some were not listed.

`npm test` was also run in the exported folder, on 2026-10-26: 813 run, 812 pass, 0 fail, 1 skipped. The ledger test (`scripts/numbers-ledger.test.ts`) reads a private word list of names when one exists on the machine and skips only that check when it does not; it still checks the banned words and the model names. Other commands: `npm run ledger` rewrites the numbers ledger of the judge pack from the files in `docs/measurements`; the development-set command (`npm run eval:dev`) runs the development set 3 times through the product's cause module, calls the model and costs money: $0.0100 [C7] per cause call on the development set ($0.57 for its 57 calls). This repository is built from a private working copy through an allow-list export; the exporter itself is not part of it.

## Evaluation

- **Sealed sets.** Three sets are kept outside this repository and sealed by hash before any model was run on them: a set of cases written in a separate session (H-a), a set rebuilt from real public fix commits (H-b), and a checklist baseline written in a separate session (B2). H-a and B2 were written by separate Claude sessions that were not given the prompt, the baseline or the development cases; that is the same model family as the one the product calls, so they may favour it. No person audited the labels: a separate Claude agent checked the 36 H-a labels before the run (35 right, 1 ambiguous and left out, 0 wrong; the one exclusion and its reason are in SEAL.md). H-b covers 3 of the 8 categories, and 6 of the 12 H-b fix commits carry a Claude co-author trailer and are reported separately. The hashes and the pre-registered handling are in `docs/planning/eval/SEAL.md`, which is the first commit of this repository, so the commit order shows that the seal came first. The sets were written in file shapes the harness does not read, so derived copies (code and diffs byte-identical, only the label and symptom files rewritten) were sealed in a second commit before the run; the converter is in `eval/harness`. SEAL.md also discloses that the authors of two of the sets each read a few lines of the build plan beyond what they were allowed.
- **Development set.** `eval/dev` and `eval/injection` hold the cases the prompt was built on and the prompt-injection cases; results are in `eval/runs`.
- **Harness.** `eval/harness` runs a set through the product's cause module. A sealed run is refused unless the seal file, `FREEZE.json` and the frozen files all match the committed state; only failures of the transport are re-run.
- **Numbers.** Each measured figure that comes from a measurement file is a row of the numbers ledger in section 7 of [the judge pack](docs/judge-pack.md), cited here in square brackets as the pack cites it; the ledger is computed from the files in `docs/measurements` and `eval/runs`. The few that come from the build log are marked [log-N] in the judge pack.

## Limits and known misses

- A target we set was missed: polling for 10 minutes used 102 vs 60 [L3] database commands. In a replay of the page's own polling on an in-memory Redis, a page left alone used 49 vs 60 [L4] and a page in use 266 vs 60 [L5]. We restated the target on 2026-10-21: the 60 now applies to a page left alone; a page in use is bounded by the cost of one poll and the hourly caps.
- When the late payment of the story “A late payment wins” is the event that makes the gap visible, the gap is called 12.5 to 14.8 s [G10] after that payment arrives, and 31 to 60.3 s from the first event the witness heard, because the late payment reached the shop only as a PayPal resend.
- One of the 12 trials with the shop answering 200 did not heal ("the ring was refused although the state was ready (not_listed)"), which is 11 of 12 [H1] healed. Of the entries with the shop rejecting with 401, only 4 of 17 [H2] healed.
- A resend sent while PayPal was still retrying the event on its own reached the shop in 2 of 7 [H10] cases, which is why Ring again is locked in that window.
- The shop Doorbell watches is the demo shop in this repository. For a shop of your own there is no reporter yet, and without one the shop's own answers are unknown, so a delivery it ignored cannot be told from one it never received.
- The live lane can show an open dispute when the scan finds one, but nothing in the lane makes one, so the dispute story exists only as a recording.
- The hosted site does not connect to a visitor's own PayPal app or keys, by design.

## Licence

MIT, see `LICENSE`. Built by one person, with Claude Code, for the PayPal AI Hackathon.
