# Backfill NFT metadata initialization

The metadata Timeline starts with **Initialized** at the transaction that set
the original URI. Subsequent URI changes are **Edits**. A later issuance does
not add a Timeline entry. A direct creation mint or burn-and-redeem setup
serves as initialization when it also establishes the original metadata.

The [audited sources](nft-history-repair-sources.json) cover 569 Memes and
71 Meme Lab tokens through finalized block 26332507. Of the 640 starting rows,
251 already reference the verified initialization transaction and 389 need
their transaction and timestamp corrected. All 640 already store the original
URI. The two Manifold V3 cases, Lab 5 and 6, provide an additional assignment
transaction to prove which token the older claim setup belongs to. The earlier
setup supplies the timestamp and URI displayed by the API.

## Dry-run and apply

1. Use a fixed finalized cutoff at or above all listed sources. In staging,
   copy each case to a separate `nft-history-repair` request, omit the optional
   `expectedTimelineCount` annotation, and supply `action: "dry-run"` and
   `cutoffBlock`. Run all 640 dry-runs before authorizing writes. Export the
   manifests, verify the 640 unique contract/token pairs and retain a scoped
   snapshot of the legacy and event rows.
2. Review the one-row baseline change for each token. Reject unexpected URIs,
   missing/duplicate baselines, wrong claim assignments, and edits outside
   the reviewed transaction lists. All nine pre-issuance URI changes should
   appear at their original transactions. Six old settings-only transactions
   should be represented by hidden event receipts. Meme 216 also corrects its
   first post-issuance Edit diff. Memes 275 and 304 each retain one correctly
   attributed Edit. Lab 71 starts at claim initialization.
3. After staging review and separate authorization for the target environment,
   use the existing replay apply gate. Send the same fields with
   `action: "apply"`, the reviewed `approvalDigest`, and a fresh UUID v4
   `jobId` per token. Apply serially or at a reviewed bounded concurrency.
   Keep a receipt list and retry interrupted jobs with the same ID and digest.
   An approval mismatch requires a fresh review. Each token's baseline, edits
   and job completion commit in one transaction.
4. Reconcile all 640 results against the manifests. Verify exactly one
   Initialized card per token, no issuance cards, the correct origin links,
   and the expected Edit transactions. Check the UI for a direct creation,
   a burn-and-redeem setup, Lab 5/6, #213, #216 and #275/#304. Restore the apply
   gate after completing the batch.

Deploy only `nftHistoryLoop`. The existing public response shape supports the
Initialized label. No new schema is required. The repair uses the existing
history and replay tables and does not rewind scheduled ingestion. The plan
covers the audited origins and known Edit corrections, while unverified older
eventless updates remain outside this historical batch.
