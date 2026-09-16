# Membership source producer coverage

`MEMBERSHIP_SOURCE_TRACKING_MODE` is deployment owned and defaults to `inactive`.
The `tracking-v1` path is staging only and requires provisioned source receipts.
Unknown or active source evidence stops the write. Keep tracking inactive until
this inventory, bootstrap receipts, and the combined writer deployment have
been reviewed together. `membership-producer-coverage.test.ts` fails if a
guarded low-level writer gains a new call site without an inventory update.

| Authoritative write and caller | Deploy unit | Source claim and refresh target | Atomic or replay contract |
| --- | --- | --- | --- |
| REP/CIC rating edit, bulk rating, bulk REP: `ratings.service.ts` → `ratings.db.ts`; API REP/CIC routes | API | GLOBAL RATINGS → FULL | Rating and derived identity totals commit with source version and request. WAVE_REP is outside eligibility. Bulk profile creation separately claims GLOBAL IDENTITY. |
| Over-credit revocation: `ratings.service.ts` → `ratings.db.ts` | overRatesRevocationLoop | GLOBAL RATINGS → FULL | Each bounded revocation transaction commits rating, identity, version, request together. |
| Help bot signup, setup, daily, question spend/refund: `help-bot-credits.service.ts`; `identities.service.ts` signup caller | API, helpBotReplyLoop, xTdhLoop | GLOBAL RATINGS → FULL | Credit event, REP rating, and identity total share one transaction. During xTDH universe, the explicit `xtdh-universe` caller marker delegates this write to that RUNNING cycle. |
| Profile and identity creation: `profiles.service.ts` → `identities.service.ts` → `identities.db.ts`; direct API profile upsert; bulk rating | API, xTdhLoop | GLOBAL IDENTITY → FULL | Caller-owned transaction begins the source claim before inserts. `bulkCreateIdentities` requires the `profile-creation` or `xtdh-universe` marker in tracking mode; the latter runs under the xTDH source cycle. |
| Profile primary address and identity consolidation: `delegationsLoop/index.ts`, `identity.ts`, `db.ts`, `profiles.service.ts` | delegationsLoop, tdhLoop | GLOBAL IDENTITY, TDH_XTDH, RATINGS, GRANTS, DELEGATIONS, and OWNERSHIP as applicable → FULL | Durable TDH/delegation cycle starts before the first TypeORM write. One shared GLOBAL barrier stays active through xTDH universe and stats activation. Partial retry replays the same source range; the block marker commits with `TDH_INPUTS_COMMITTED`. |
| Profile merge group REP/CIC rule refs: `profiles.service.ts` → `user-groups.db.ts` | tdhLoop, delegationsLoop | GLOBAL GROUP_CATALOG and all affected `membership_group_versions` → FULL | Set-based `INSERT ... SELECT` versions every group in the profile merge transaction, including more than 128 groups. Profile list-row moves are source-local under GLOBAL IDENTITY. |
| Group creation and visibility replacement: `user-groups.service.ts` → `user-groups.db.ts` | API | GLOBAL GROUP_CATALOG plus each changed group version → GROUP | Group definition, list rows, catalogue version, group versions and requests commit together. |
| Wave and curation group selection: `wave.api.service.ts`, `curations.api.service.ts` | API | GLOBAL GROUP_CATALOG plus changed group version → GROUP | Integration branch owns these direct selection writers; include their reviewed commits before activation. |
| Grant create/update/review and overflow replacement: `create-xtdh-grant.use-case.ts`, `xtdh-grants.finder.ts`, `review-xtdh-grants-in-queue.use-case.ts`, `re-review-rates-in-xtdh-grants.use-case.ts` | API, xTdhGrantsReviewerLoop, xTdhLoop | GLOBAL GRANTS → FULL | API and reviewer transaction claims GRANTS directly. xTDH overflow replacement runs inside the shared TDH cycle. Profile merge grantor rewrites run under the TDH/delegation cycle. |
| Native NFT owner reconciliation: `nftOwnersLoop/nft_owners.ts` → `db.nft_owners.ts` | nftOwnersLoop | GLOBAL OWNERSHIP → FULL | Stable sync-block job holds a durable RUNNING barrier across raw and consolidated TypeORM writes. Retry rebuilds the fixed transaction range from block zero so partly committed balances are never applied twice. |
| External collection snapshot: `external-collection-snapshotting.service.ts` → `external-indexing.repository.ts` | externalCollectionSnapshottingLoop | GLOBAL OWNERSHIP → FULL | Stable partition/block job protects replayable owner/history upserts; snapshot success and source completion commit together. |
| External collection live tail: `external-collection-live-tailing.service.ts` → `external-indexing.repository.ts` | externalCollectionLiveTailingLoop | GLOBAL OWNERSHIP → FULL | Stable partition/block-range job commits transfer/history/current-owner changes and source completion atomically. Head advancement may retry after completion. |
| Full TDH and xTDH: `tdhLoop/index.ts`, `tdh_consolidation.ts`, `xTdhLoop/index.ts`, `recalculate-xtdh.use-case.ts`, `recalculate-xtdh-stats.use-case.ts` | tdhLoop → xTdhLoop | GLOBAL TDH_XTDH, RATINGS, IDENTITY, GRANTS → FULL | One cycle ID survives SNS/SQS universe and stats messages and retains the UTC TDH calculation date for prior-day input replay. State advances `STARTED` → `TDH_INPUTS_COMMITTED` → `UNIVERSE_COMMITTED` → `STATS_ACTIVATED` → completed. Statistics slot activation and its checkpoint share one transaction. Late messages for a completed cycle are no-ops. |

Source work is intentionally broad during initial staging validation: ratings,
grants, ownership and identity edits request FULL refresh rather than relying
on a new profile's unprovisioned PROFILE source row. The reader must use direct
fallback for any profile without an exact bootstrap receipt. Per-profile
targeting can be restored after dynamic profile birth receipts are audited.

Before a deployment enables tracking, verify all deploy units above run the
same frozen mode and stage, provision GLOBAL and existing PROFILE source keys
with the reviewed coverage revision, and deploy xTdhLoop before TDH and
delegation senders. A failed producer job retains its barrier and requires
same-cycle replay or explicit repair; a new cycle must never clear it.
