# Claims Arweave upload recovery

The claims worker uses the shared uploader introduced by PR #2587. This change
preserves the existing decisions to reuse external Arweave/IPFS links and
completed media. Only media which the existing workflow uploads enters recovery.
No S3 objects or replacement source copies are created.

## Durable state

The nullable JSON column `minting_claims.media_upload_state` holds the claim input
fingerprint, per-artifact source URL/content type/length/SHA-256, public signed
transaction and acknowledged contiguous chunk prefix, and recovery counters.
Private wallet keys and media bytes are never included. Small metadata bytes are
frozen separately so retries across issuance-month boundaries publish the exact
original document. Metadata checkpoints support up to 750,000 decoded bytes.

Before posting a transaction, its checkpoint must commit. Each acknowledged chunk
must commit before the next begins. A lost acknowledgement replays the same signed
header or chunk; it never signs a replacement. Resume re-downloads the existing
source and verifies its hash, byte count, signed data root, transaction signature,
transaction ID, signer, content type and chunk bounds. Corrupt state or changed
bytes fail closed. Input changes require a new explicit publication request.

Checkpoint and final-receipt writes require the current unexpired owner token on
the writer. The worker awaits pending checkpoint writes before releasing ownership,
including writes whose caller was cancelled. Completion atomically stores the final
media/metadata locations, clears recovery state and clears intent/ownership. If that
commit's acknowledgement is lost, a duplicate either sees inactive intent or resumes
the already-completed transaction. No new metadata transaction is needed.

## Timing and failure handling

- Worker: 4096 MB, 900-second configured runtime, reserved concurrency two.
- Each lease lasts the invocation's remaining runtime plus 30 seconds, up to 930
  seconds. A hard kill cannot release it; a contender waits for its database-clock
  expiry instead of restarting an upload while the previous owner might run.
- The worker stops upload work with 60 seconds reserved for cleanup. A new source
  fetch requires another 120 seconds for the existing fetch bound. Shared uploader
  session deadlines and parent cancellation preserve the last durable prefix.
- A progress-making deadline handoff requests redelivery after two seconds. Other
  recoverable failures use bounded exponential backoff with jitter, approximately
  10–123 seconds. The SQS poller can add delay; these are eligibility times.
- The existing queue visibility stays 930 seconds for unhandled crashes. Controlled
  retries use `ChangeMessageVisibility` on the current receipt and return that
  message in `batchItemFailures`; they must never acknowledge unfinished work.
- Ten recorded upload failures, 128 owned attempts, or 24 hours exhaust automatic
  recovery. Progress-making deadline handoffs do not increment failures. Killed
  attempts without durable progress count as failures on the next acquisition.
- The queue's 1000-receive DLQ backstop protects against transport/initialization
  failures independently of application counters. DLQ delivery remains an operator
  recovery case when the database or worker cannot run at all.
- Terminal validation/protocol/checkpoint errors and exhausted budgets persist a
  failed state, clear publishing intent and issue a priority alert. Redelivery then
  performs no upload. Alert delivery remains best effort after the failure commit.
- An explicit admin retry resets recovery budgets while retaining signed transactions
  for unchanged inputs. Automatic redeliveries cannot reset these budgets.

## Rollout and rollback

Deploy `dbMigrationsLoop` first for the additive JSON column (the bounded
`claims-media-upload` schema scope supports it), then `claimsMediaArweaveUploader`,
then `api` for explicit retry-budget reset behavior. There are no OpenAPI, event
payload or new environment-variable changes. Other shared-uploader consumers keep
their existing embedded-source checkpoint behavior and session limits.

Rollback must account for active compact checkpoints: older claims workers do not
understand them and can sign duplicate uploads. Complete active jobs with the
recovery-aware worker, or disable consumption and preserve their checkpoints before
rolling back. Do not clear checkpoints or redrive a DLQ into an older worker blindly.
The added nullable column may remain in place.

## Verification

`./bin/6529 exec jest --config scripts/claims-upload-jest.config.cjs` exercises
compact checkpoint size with a 226 MB source, real local signing and transaction
verification with mocked gateways, lost chunk acknowledgements, changed sources,
metadata recovery, pending-write fencing, terminal budgets, retry visibility,
ownership loss, schema plan guards and existing link reuse. It submits no live
Arweave transactions and uses no production data writes.
