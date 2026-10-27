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
- Run a metadata fetch failure and an unmapped claim through the processor. A failed window must not advance the normal checkpoint.
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

The legacy discovery pass completes before event ingestion begins; these phases cannot interleave in one invocation, and the Lambda retains reserved concurrency one. Direct `setTokenURI` writes now use the same position-aware event processor. An unprocessable event deliberately holds its window; the invocation throws through `wrapLambdaHandler` into operational error/Sentry reporting rather than silently advancing. Operators must monitor Lambda errors and checkpoint age and resolve the named event before progress can resume. No skip-ahead or lossy quarantine is implemented.
