# Backend Arweave recovery

All backend Arweave network operations use the shared subsystem in `src/arweave/`.
Canonical transaction identity and historical input URLs remain distinct from the
active gateway endpoints used to retrieve or submit that transaction.

## Ownership and active gateways

`gateways.ts` is the only active endpoint registry. Reads prefer ArDrive and
`gateway.ar.io` before the Arweave endpoints when recovering a failed input URL.
Native wallet, price, transaction and chunk operations use ArDrive and
`arweave.net`. The old `ar-io.net` and `turbo-gateway.com` addresses remain
recognized inputs but are not offered as active fallback candidates. They failed
DNS and TLS hostname validation, respectively, during the incident audit.
Do not disable TLS validation to make a candidate appear healthy.

`withArweaveFallback` is the compatibility entry point for content reads. A
callback must use its supplied abort signal and consume and validate the full
response before returning. HTTP error checks outside the callback do not trigger
failover. Unknown HTTP origins retain their existing fetch policy; IPFS handling
is unchanged. Every alternate content request still passes through the caller's
public-network/redirect validation, byte caps and content validation.
`createArweaveClient` provides SDK network reads through the same registry and
bounded recovery policy. Local signing and conversion do not contact gateways. SDK responses must be
buffered; `webstream` is rejected before making a request.
Status queries accept pending HTTP 202 or a validated HTTP 200 confirmation;
text mode validates parsed JSON while preserving the original response text.
Raw URL inputs retain `/raw/<id>` on each path-style alternate, bypassing
manifest index resolution as specified by the [gateway raw-data contract](https://docs.ar.io/build/access/fetch-data/).
Raw-mode recovery does not invent a transaction-subdomain endpoint; manifest
paths on ordinary transaction-subdomain inputs retain their existing meaning.
An explicit path-style raw input always derives `/raw/<id>` alternates, even
when the input includes a path suffix. That suffix is not treated as a manifest
path and is not appended to the raw endpoint. The original input is tried first.

## Upload identity and recovery

Caller-supplied tags are applied before signing, including subscription opening/history discovery tags. Gateway retries and saved resumes retain the original signed tags.

`ArweaveUploadSession` is the shared uploader, extracted from the existing TDH
engine. It signs once, submits the same public transaction header to each
required gateway, and retries identical chunk proofs and bytes. Each gateway's
header registration is coordinated before concurrent chunks. Explicit protocol
validation errors are terminal; transient failures rotate gateways and may get a
second round after a propagation delay. A `data_root_not_found` chunk response
invalidates that gateway's observed header registration so the signed header can
be submitted again. Late responses from older workers cannot invalidate a newer
registration. Only HTTP 200 acknowledges a chunk; other successful HTTP statuses
retry the identical bytes without advancing persisted progress. Header submission
still accepts HTTP 208, and resumed status probes accept HTTP 202 or an HTTP 200
confirmation with the expected shape.

The file-uploader facade preserves the SDK's inline-data path for an unposted
one-chunk transaction, including a restored checkpoint: `POST /tx` includes the
original signed transaction and data, and
HTTP 200 records complete progress. An ambiguous successful status, including
duplicate-header HTTP 208, requires separate chunk acknowledgement if alternate
inline submissions cannot establish acceptance. Saved checkpoints retain their
existing format. Known posted transactions resume through the header/chunk path
unless their data progress was already durably acknowledged. A known transaction status alone
never completes a saved chunk. TDH retains its existing header/chunk path.

Durable consumers checkpoint the signed transaction and original bytes before
submission and after each acknowledged step. They upload sequentially so the
persisted chunk index is a monotonic contiguous prefix. A resumed upload rebuilds
and verifies the signed data root; regenerated caller bytes never replace the
saved bytes. Each resumed gateway registers the original signed header before
receiving chunks; a prior acknowledgement does not establish gateway-local state. Re-registering the identical signed header at another gateway does
not create or sign a replacement transaction. A failed checkpoint stops work.
Checkpoint waits share the session deadline and receive its abort signal. A
cancelled wait cannot undo a database write already in flight: CMS retains that
lease while the write is pending and fences persistence under its existing
row-lock/token ownership check. A stale attempt cannot overwrite a replacement
owner's checkpoint. Successful checkpoints still finish before the next chunk.
The SDK's potentially hour-long internal upload retry loop is not used.

TDH retains eight concurrent chunk workers and its 120-second total budget. The
shared file-uploader facade uses a bounded ten-minute budget for larger media;
this is separate from NFT preview timing. Network requests have a ten-second
attempt bound and a 64 KiB response cap, including resumed status probes and
gateway error bodies. Parent upload cancellation stops in-flight network requests and
backoff. No private signing keys are included in checkpoints or diagnostics. Provider
response diagnostics use only recognized codes or generated numeric peer summaries.

## NFT preview behavior

The existing size limits are preserved and still read from runtime configuration.
This change does not assume a production size override or increase a size cap.
The preview worker retains its 15-second per-hop response-header timeout,
90-second maximum overall download, and 120-second Lambda timeout. An Arweave
gateway gets at most 30 seconds within that download budget, leaving room for
alternatives. Body inactivity aborts an attempt after ten seconds by default.
`NFT_LINK_MEDIA_PREVIEW_BODY_IDLE_TIMEOUT_MS` is an optional positive integer
runtime setting, owned by `nftLinkMediaPreviewLoop`; unset means `10000`.
Existing download/header settings continue to apply.

A size rejection is a typed, persisted policy outcome and does not emit an
operational error alert. Existing source-and-size-policy cooldown checks prevent
immediate requeueing. Cached preview URLs are preserved by fenced failure writes.
Animation-to-image fallback remains available for its existing supported cases.
A gateway timeout or HTTP failure recovered elsewhere is not a terminal failure.
If recovery fails, the preview worker still persists and reports the final error;
failed persistence still rejects the invocation. Gateway attempts and recoveries
record only host, attempt, duration and fixed categories. Stalled-body diagnostics
also record received bytes; they do not publish arbitrary URLs, payloads or keys.

## Caller and deployment inventory

| Deploy unit                  | Arweave work                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `nftLinkRefresherLoop`       | NFT metadata reads through the shared resolver HTTP helper                                                           |
| `nftLinkMediaPreviewLoop`    | Media downloads, idle detection, policy rejection handling                                                           |
| `api` (`seizeAPI`)           | CMS verification/upload, claim-media inspection, health balance/price queries; API policies unchanged                |
| `claimsBuilder`              | Claim-media inspection through safe fetch                                                                            |
| `claimsMediaArweaveUploader` | Source-media reads and shared uploads                                                                                |
| `nftsLoop`                   | Metadata reads and validation inside gateway attempts                                                                |
| `nftHistoryLoop`             | Metadata reads, including approved sandbox redirects                                                                 |
| `s3Uploader`                 | Shared image/media retrieval                                                                                         |
| `tdhHistoryLoop`             | CSV retrieval, HTTP/body/CSV validation inside fallback                                                              |
| `rememesLoop`                | Source-media reads/probes and CSV uploads; includes `rememesS3Loop`, `rememesRefreshMetadataLoop`, `rememesFileLoop` |
| `subscriptionsDaily`         | Shared snapshot uploader; bundle also contains `subscriptionCoverageReconciliationLoop`                              |
| `overRatesRevocationLoop`    | Optional ratings-snapshot upload                                                                                     |
| `signedRecordLogLoop`        | Shared archival upload; bundle contains `signedRecordLogCloser` and `signedRecordLogArchiver`                        |
| `royaltiesLoop`              | Shared CSV uploader                                                                                                  |
| `teamLoop`                   | Shared CSV uploader                                                                                                  |
| `tdhLoop`                    | Shared upload engine with existing TDH budget/concurrency                                                            |

No API schema, database schema, queue or event-payload change is required. These
units can roll out independently because no cross-service wire contract changes.
Recommended verification order is NFT refresher and preview, other read consumers,
upload consumers, then API. No schema deployment is required for this change.

## Verification and boundaries

Run `./bin/6529 exec jest --config scripts/arweave-jest.config.cjs` for the
DB-independent recovery, native upload integrity, caller and loopback transport
checks. The boundary test checks selected SDK creation/upload method names and
recognized SDK receivers calling `api.post` on `tx` or `chunk` outside the shared
subsystem. It is an AST guard, not an exhaustive detector of arbitrary direct
HTTP submissions. Caller tests cover JSON validation, policy failures,
content hashes, redirects, body-idle recovery, partial progress, lost responses,
terminal errors and bounded cancellation. These tests never submit live uploads.

After an independently authorized rollout, verify the previously failing NFT
metadata and media, including a real `READY` preview or accurate policy outcome.
Compare a full day of processing successes and final failures, accounting for
traffic, before evaluating Discord volume. Size-limit increases and broader
persisted backoff for ordinary failures remain separate follow-ups.
