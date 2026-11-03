# Repair historical NFT Timelines

Use one `nft-history-repair` request per NFT. Each request names the exact
claim-update transactions to reconcile and optionally the first Mint transaction
to verify and restore. The [audited sources](nft-history-repair-sources.json)
list the inputs for the eleven affected NFTs and the expected public counts.
The counts assume no additional edits since the audit.

1. On staging, copy a case into a request and remove `expectedTimelineCount`.
   Add `"mode": "nft-history-repair"`, `"action": "dry-run"`, and a numeric
   `cutoffBlock` at or below the finalized head and at or above all sources.
2. Review the manifest against the NFT and the chain transactions. In particular,
   verify the corrected Mint, the visible Edit descriptions, and any settings-only
   ledger entry that supersedes a legacy Edit. A Mint URI collision may remove
   the obsolete legacy row after the same plan accounts for its transaction in
   the ledger. Keep a scoped pre-repair snapshot for rollback.
3. With separate authorization for the target environment, use the existing
   replay apply gate. Change the action to `apply` and supply a fresh UUID v4
   `jobId` and the exact `approvalDigest` returned by the dry-run. The remaining
   fields must match the dry-run. Repeat an interrupted apply with the same
   request and job ID. Review a fresh dry-run if the evidence or stored history
   has changed.
4. Verify the NFT history API and Timeline against the sources. Confirm the
   completed job can be retried and restore the apply gate after the repair.

The nine URI changes before first mint belong at their original transaction
positions. The six later settings-only transactions remain in the ledger without
public Edit descriptions. Meme 216 retains both pre-mint Edits and its four
post-mint Edits, with the first post-mint diff corrected. Lab 71 moves its Mint
to the first positive issuance. Memes 275 and 304 each retain one Edit at the
earlier URI-changing transaction and one hidden settings-only ledger record.

Use `nftHistoryLoop` for the repair. Each NFT's changes and job completion share
one transaction. The scheduled checkpoint and replay apply gate use the
existing configuration.

The API can order ledger events within a block using their transaction and log
positions. Legacy Mint rows store only the block, so their position relative to
other events in the same block retains the existing legacy ordering. The audited
repairs do not have a Mint and Edit in the same block.
