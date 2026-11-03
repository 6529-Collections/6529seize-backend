# Claim metadata history rollout

## Scope and safeguards

Meme #550 has confirmed missing URI edits at blocks 26254530 and 26276048. Both emit `ClaimUpdated` from the Manifold ERC1155 claim extension, with an external sender that the legacy deployer discovery excludes. The October 26 metadata also removes an object (`animation_details`) that the previous differ could not handle.

The additive `nfts_history_events` entity preserves the legacy `nfts_history` table and its URI primary key. Transaction/log identity distinguishes separate visits to the same URI. Claim settings updates with an unchanged URI have a null description and do not appear in Timeline. Historical insertion also recalculates the immediate successor diff; snapshot reconciliation and history changes share a transaction.

This change does not authorize any deployment or production replay. Never reset `nfts_history_blocks` or enable `NFT_HISTORY_RESET` to repair this incident. The legacy forced-reset option is rejected before reading or writing any history/checkpoint data; historical recovery must use reviewed bounded replay instead of an independent full-reset workflow.

## Service order

1. Deploy `dbMigrationsLoop` and invoke its explicit `{ "schema_scope": "nft-history-events" }` scope. It synchronizes only the new event table, leaving the existing history and claim mapping entities untouched. Inspect the resulting table and indexes before continuing.
2. Deploy `api` so it can combine legacy and event history without changing the public response shape. Verify legacy-only histories are unchanged.
3. Deploy `nftHistoryLoop`. Verify discovery of a finalized update sent by a non-deployer wallet, progress of the normal checkpoint, and surfaced failures without advancing past them.

Validate this sequence in staging before requesting production execution. The existing 30-minute schedule and reserved concurrency of one are retained.

## Validation before production

- Use isolated staging fixtures with distinct claim IDs and token IDs, multiple creator contracts, `A -> B -> A`, multiple updates in a single block, and removed metadata objects.
- Run a metadata fetch failure and an unmapped claim through the processor. A failure must not advance the normal checkpoint past its block; fully completed earlier blocks may remain checkpointed.
- Repeat event ingestion and confirm no duplicate history rows or changes to Mint.
- Run the MySQL integration tests in `src/nft-history/history.db.test.ts` with the repository's standard test harness. The database-independent checks are available through `./bin/6529 exec jest --config ops/scripts/nft-history-unit.jest.cjs`.
- Check the public API and Timeline after the one-minute request cache expires. Confirm dates, transaction links, old/new values, and repeated URI chronology.

## Historical audit requirements

The recovery tooling is a separate stacked change. Audit the complete lifetime of the relevant claim extensions through a fixed finalized cutoff, using bounded log windows; do not restrict discovery to #550, the newer sender, or October 23 onward. Retain every window's report, including windows with no candidate edits. Record unsupported emitters/call paths, unmapped or ambiguous claims, missing mint baselines, and metadata-fetch failures for explicit resolution.

The current decoder supports direct `updateClaim` variants and `updateTokenURIParams`. Forwarded/batched execution and unsupported protocols must be reported rather than reconstructed from current or end-of-block state. Historical mapping verification needs archive-capable `eth_call`; the normal loop must surface unavailable archive reads as failures.

The reviewed audit must list the exact event identities, contract/token mapping, source and destination URIs, proposed diffs, existing matches, and changes to successor diffs. Apply only reviewed events with a separate replay checkpoint and fresh reconciliation. Preserve all legacy rows and the normal ingestion checkpoint.

For #550, the required metadata Timeline is Mint at block 26004346, Edit at block 26254530, and Edit at block 26276048. Earlier unchanged-URI settings updates must not add Timeline edits. Verify against the two on-chain transaction hashes and all three immutable metadata documents, not only the live NFT URI.

## Rollback and incident handling

Stop replay on any discrepancy. Preserve its receipts and checkpoint for investigation. Roll back the event reader/writer services together if necessary; keep the additive table and all legacy rows. Reverting to the old API temporarily hides event-backed edits but must not erase their records. Schema rollback must never drop the legacy table or rebuild its primary key.

Normal ingestion now discovers all source transactions by creator/event, with no sender restriction. Initialization, first mint, and edits are decoded in block/transaction order; one source transaction commits its mapping and history atomically. The Lambda retains reserved concurrency one. Direct `setTokenURI` writes now use the same position-aware event processor. An unprocessable event deliberately holds its window; the invocation throws through `wrapLambdaHandler` into operational error/Sentry reporting rather than silently advancing. Operators must monitor Lambda errors and checkpoint age and resolve the named event before progress can resume. No skip-ahead or lossy quarantine is implemented.

## Bounded replay invocation

The same `nftHistoryLoop` Lambda accepts an explicit manual replay mode. No replay schedule or self-invocation is installed. Normal scheduled events continue ingestion. Replay never registers the normal checkpoint entity, never synchronizes entities, and skips Redis initialization.

After an authorized rollout of both changes, create the additional job table through `dbMigrationsLoop` with `{ "schema_scope": "nft-history-replay" }`. Both schema scopes must finish before using replay. Keep `NFT_HISTORY_REPLAY_APPLY_ENABLED=false` until the operator separately approves execution; `true` is required only for apply/resume and must be returned to `false` after the authorized repair.

An audit request looks like this (use a real, recorded finalized cutoff consistently across every window in the campaign):

```json
{
  "mode": "nft-history-replay",
  "action": "dry-run",
  "fromBlock": 26254530,
  "toBlock": 26254530,
  "cutoffBlock": 26276048
}
```

These sample blocks are a regression slice, not the complete affected range. Determine and record the earliest relevant claim initialization/extension deployment block from on-chain evidence, then enumerate every block window through the selected cutoff for all supported creator contracts and emitters. Each request accepts at most 2,000 blocks and 25 claim-update events. Split dense windows or windows that exceed the time/response budget; never mark an unprocessed window complete. Audit also discovers unknown emitters sharing the claim event signature and reports them as unverified.

Invoke synchronously through the normal AWS CLI/SDK with the target account and region explicitly selected. For example, save the JSON to `audit-request.json`, then run `aws lambda invoke --function-name nftHistoryLoop --region <target-region> --cli-binary-format raw-in-base64-out --payload file://audit-request.json audit-report.json`. Check the invocation's `FunctionError` as well as the JSON body; a transport-level success alone does not establish audit success. Do not use asynchronous invocation, which discards the reviewable result.

Save every returned `manifest` and `approvalDigest` outside the source repository. The manifest lists exact source log references, creator/token mapping, predecessor URI, resulting URI, metadata diffs, successor corrections, existing-event matches, settings-only audit inserts, and failures. A dry-run writes no history, jobs, normal checkpoints, or replay checkpoints. `applicable=false` means the window is blocked; retain the failures and resolve them or narrow the range without dropping coverage. A window with zero events is still a required coverage receipt.

## Apply and resume after separate authorization

Review the complete audit, including mapping gaps and any successor changes. Re-run the audit after correcting mappings or changing code; an old digest must not be reused for a changed proposal. For one approved window, choose a new UUID v4 job ID and submit the same bounds with the reviewed digest:

```json
{
  "mode": "nft-history-replay",
  "action": "apply",
  "fromBlock": 26254530,
  "toBlock": 26254530,
  "cutoffBlock": 26276048,
  "jobId": "55000000-0000-4000-8000-000000000001",
  "approvalDigest": "<64-character-digest-from-the-reviewed-dry-run>"
}
```

Apply first re-audits the entire window, refuses unresolved failures or changed approval digests, and binds the job ID to the approved manifest. Job IDs are never upserted or rewound. Every event is revalidated against canonical receipts and historical mappings; current history and refetched metadata must reproduce the reviewed plan. Only then are the history changes and the job's `next_index` committed in one transaction. A change to history, metadata, mapping, or chain anchors stops the job for renewed review.

If the result has `complete=false`, repeat the identical apply request to resume the saved manifest. The process yields before starting another event when less than 90 seconds remain. Retrying a completed job makes no additional history writes. `nextFromBlock` is returned only after the whole window completes; retain the completed job receipt and use a new dry-run/digest/job for the next window. The fixed cutoff and saved receipts provide campaign coverage across windows; each job supplies durable event-level resume progress within its window.

Do not skip a stalled event, reuse a job ID with new bounds, force a stored cursor, delete old history, or change the normal checkpoint. If a stale plan cannot resume, retain that job as evidence, generate a fresh audit over its remaining range (including existing-event matches), and request approval for the new digest.

## Meme #550 reconciliation

Validate the three immutable metadata versions in order:

1. Mint: `IFosq_ZN9_PrDSQmq65JTjeB2GnnfPSFoHxRazxC4PY`.
2. October 23, block 26254530, transaction `0xcfccbfa73df78f66df944d4d0203bcd2e886fe3110c3e018ac812bcdb730bd05`: `WzsBy-SqOkS8Pr-jIL9J1LX4KLZmgzuqSu8ee79K234`; description and `Issuance Month` change.
3. October 26, block 26276048, transaction `0x4ddb9f379e14a4103d9b09a571d9e569c30911f75335d3c26388d97f6d2b3acf`: `yEEVNbUIvVuF1Yb_rRUEmdrrGg3Lj7ZZa-4KBYqJsmg`; image references/details change and animation references/details are removed.

After an authorized apply, confirm history API `count: 3`, an unchanged Mint transaction, both Edit transaction hashes/timestamps, and the exact sequential diffs. Wait for the one-minute API cache to expire or invalidate only affected request keys. Open `/the-memes/550?focus=timeline` and confirm three entries with the correct links and old/new values. Repeat the same job and reconcile counts again. Verify the normal loop checkpoint stayed unchanged throughout replay and that the next normal run still progresses. Staging proof and the production dry-run/approval receipts must be retained before considering recovery complete.

Direct core `setTokenURI` edits share the same ordered processor. Manifold emits no URI event for that method, so its verified top-level calldata operation uses the transaction identity with reserved log index `-1` and a null claim ID. Real `ClaimUpdated` records always use their non-negative receipt log indexes. Unprocessable events hold the scan window and throw through operational error/Sentry reporting; monitor Lambda errors and checkpoint age and resolve the named event rather than skipping it. All source transactions share one chronological planner, and reserved concurrency remains one.

`nextFromBlock` is an advisory coverage hint, not an executable request or permission to advance. Match it against the campaign's contiguous-window ledger and generate a fresh reviewed dry-run/digest/job for every next window. Reserved concurrency one serializes manual replay and scheduled invocations of this Lambda; neither can execute concurrently with the other. RPC and metadata preparation happen outside row locks. Any separate writer that changes history before the transactional snapshot check makes the plan stale and stops apply safely. Before rollout, run the MySQL integration tests to confirm native JSON reads after both event inserts and successor updates; the database-independent serialization check verifies that both paths bind the same JSON representation.

Metadata fetching accepts HTTPS decentralized gateways from the shared gateway catalog (including Arweave sandbox redirects), validates every redirect, and caps decoded metadata at 2,000,000 bytes with one 15-second deadline across fallback attempts. Custom protocol-1 origins and oversized metadata fail the window explicitly. Audit such failures and review any gateway-policy extension before rollout; do not skip the event or advance its checkpoint.


## Sender-independent initialization and Mint recovery

The remaining deployer-only scan has been removed. Normal ingestion discovers creator-scoped claim initialization/update logs, creator ERC1155 mints from the zero address, and URI events. Direct calls to the Memes/MemeLab creator contracts are paginated independently of sender to discover eventless top-level `setTokenURI`. The live claim query is restricted to verified extension addresses; audit discovers unknown emitters for explicit review. Unlisted claim-signature logs incidentally present in another discovered mint receipt are ignored by normal decoding, while explicitly discovered unlisted logs still fail audit. Do not replace the former sender with another wallet allowlist.

A verified initialization records the actual claim/token association. Claim Mint history is the first positive-supply mint, whether it is an airdrop, paid `mint`, or `mintBatch`, and regardless of who submitted it. Zero-supply claim token creation is mapping evidence, not another public Mint. Direct base/burn-redeem initialization retains its creator mint evidence. Later mints preserve the existing baseline. Existing Mint timestamps are never upserted or moved. Historical claim state and preceding same-block calls establish the URI at the transaction position; end-of-block URI alone is insufficient. Unsupported layouts, unknown mint sources, missing earlier supply baselines, and forwarded metadata calls without exact execution calldata stop the window explicitly.

The current scanner supports event-backed operations and direct creator calls. Eventless forwarded URI writes require execution-trace discovery and are outside this direct-call scanner. Do not claim those call shapes are covered by the top-level `toAddress` query.

Normal ingestion processes at most 1,000 blocks per invocation (five 200-block windows), down from the former 10,000-block maximum. Each window discovers 20-block chunks and checkpoints only fully completed blocks. A later budget/fetch/decode failure preserves the completed prefix; the next invocation starts at checkpoint + 1. If a block is interrupted, already committed sources in that block are replayed idempotently and all remaining sources must finish before its checkpoint advances. A single block or source that cannot fit its execution budget still needs explicit investigation; it is never skipped. At 12-second blocks, roughly 150 new blocks arrive each 30-minute schedule; the theoretical backlog reduction is 850 blocks per complete invocation, with actual throughput depending on source density and RPC/metadata latency. Alert when the checkpoint stops advancing for two scheduled invocations or falls more than 300 finalized blocks behind. An extended outage needs an explicitly monitored catch-up plan; do not increase windows or skip sources blindly. One source transaction is bounded to 100 distinct minted tokens; larger batches fail explicitly for review.

The additional manual mode recovers mappings and baselines through the application planner:

```json
{
  "mode": "nft-history-source-replay",
  "action": "dry-run",
  "fromBlock": 26125630,
  "toBlock": 26125644,
  "cutoffBlock": 26327416
}
```

This #557 example covers initialization and first positive mint, not a complete historical campaign. #569's initialization/first mint are at blocks 26326676/26326684; verify these bounds against the saved archive evidence before executing. Audit all candidates found by the collection-wide screen: Memes #557/#569 and MemeLab #57/#60/#61. Preserve coverage receipts between separately audited windows. In particular #57's initialization (19331658) and first paid `mintBatch` (19334129) exceed the 2,000-block limit together: audit/apply separate bounded windows with the same finalized cutoff. An empty Timeline alone is a candidate; prove actual positive supply before proposing a Mint.

Review every proposed mapping and Mint/edit, including other transactions in the same block/window, failures, and successor changes. The source manifest is version 2. Its mode-qualified immutable request and digest are distinct from update-only replay; never reuse old job IDs across modes. No new schema, schedule, environment flag or frontend API shape is introduced. Existing `nft-history-replay` jobs remain version 1 and can still resume through their original mode.

After separate write authorization, submit the same bounds with `action: "apply"`, a new UUID-v4 `jobId`, and the freshly reviewed source `approvalDigest`. The existing `NFT_HISTORY_REPLAY_APPLY_ENABLED=true` gate is required. A source transaction's claim mapping, Mint/edit writes and replay cursor share one DB transaction. Retry an incomplete job with the identical request; completed retries are idempotent. Return apply to false on success or failure. Source replay never changes the normal checkpoint.

Validate on staging before production: reproduce alternate-wallet initialization plus initial airdrop, first paid mint, distinct claim/token IDs, multiple creator contracts, same-block URI changes, subsequent editions, decode/fetch failures, stale digests and interrupted/resumed jobs. Reconcile claim mappings and public API/Timeline counts; each of the five missing-baseline NFTs should gain exactly one verified Mint, without affecting #550's Mint/two edits. Advance the ordinary loop afterwards to prove scheduling still works. Only `nftHistoryLoop` needs deployment for this follow-up when the event/job tables and reader from the earlier rollout already exist. No production recovery is authorized by merging or deploying the code alone.

MemeLab #22's older extension verifies its mapping through historical `getClaim`, because that generation has no `getClaimForToken` method. Unchanged-URI settings inserts do not refetch/rewrite an unchanged successor diff. The separate legacy attribution corrections for #275/#304 still require their reviewed reconciliation order; this source recovery mode does not silently delete legacy no-op rows or move their original records.

Deployment alone does not reconstruct missing initialization/Mint records behind the existing checkpoint. Recover a blocked NFT’s verified historical mapping and first Mint through reviewed source replay before expecting its pending updates to complete. Then let normal ingestion process the retained backlog, including newer updates beyond the original audit cutoff; verify checkpoint progress rather than relying on a CloudWatch error alarm returning to OK.
