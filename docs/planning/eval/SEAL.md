# Evaluation seal (self-registered, verifiable by commit order)

Sealed sets live outside this repo in ~/doorbell-eval-sealed/. Only hashes are committed here, before any model is run on them.

| set | file | sha256 of MANIFEST.sha256 | files | sealed at (UTC) |
|---|---|---|---|---|
| ha | ~/doorbell-eval-sealed/ha/MANIFEST.sha256 | 037dd469ef1b8fc8ffdee4e9ac1f30321fbda213c606c3660c977b901a3301d6 | 282 | 2026-10-19T03:56:08Z |
| b2 | ~/doorbell-eval-sealed/b2/MANIFEST.sha256 | b9d28098ce66e600c8a34b2fadd47def6557bb733cc4a98dac1e455d32dd6544 | 17 | 2026-10-19T03:56:08Z |

Independence notes: the H-a author and the B2 author each logged reading a few lines of plan section 5.4 beyond what they were allowed (replay item and handler file names; not cause rules). Disclosed here and in the README.

| hb | ~/doorbell-eval-sealed/hb/MANIFEST.sha256 | 50951b887c73eee76fae5107a583ae440841f372d917818c87058405d2b8fe21 | 230 | 2026-10-19T04:37:26Z |

## Pre-registered handling for H-b (decided before any model run)
- **Headline input = `nocomment/` variant.** 9 of 12 fixed files carry the fixer's own explanation of the cause in comments; feeding them would leak the answer. Original-with-comments scores are reported only as a secondary number.
- **Contamination check:** the obfuscated twin used for the original-vs-obfuscated comparison must be generated from the `nocomment/` variant with the sealed `obfuscate.mjs` before the first model call; its manifest hash is appended to this file in the same commit that precedes the run. If nocomment − obfuscated accuracy > 15 points, the obfuscated score becomes the headline.
- **Same-family risk:** 6 of 12 fix commits carry a Claude co-author trailer (`ai_attributed_commit`). Scores are reported separately for those 6 and the other 6.
- **Coverage limit:** H-b covers 3 of the 8 categories (RAW_BODY_ALTERED 6, EVENT_TYPE_DROPPED 2, OTHER_CODE_CHANGE 4). A_b is reported with this limit stated.
- `src/` upstream clones are not part of the sealed set.
