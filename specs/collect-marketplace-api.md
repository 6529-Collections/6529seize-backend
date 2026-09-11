# Collecting and marketplace API

The generated OpenAPI contract is authoritative for request and response fields.
Amounts and quantities are decimal integer strings; trade expiry is Unix seconds,
while operation freshness and saved-rule expiry use Unix milliseconds.

## Scope and authority

Collecting analyses use a profile and its confirmed consolidated wallets.
Execution requires direct wallet authentication matching the paying/signing
wallet and current profile. A social proxy or a consolidation relationship does
not authorize a wallet to trade another wallet's holdings.

The service supports Ethereum mainnet, The Memes, Gradients and Pebbles, and
verified Seaport 1.6 orders. New standard offers receive NFTs at the signing
wallet. Purchases deliver directly to any explicitly reviewed recipient,
including a third party or Safe. An external gift does not advance profile
completion or TDH. Contract-wallet execution is unavailable until its wrapped
transaction and signature paths are verified.

## Read and plan

- `GET /collect/catalog` returns definitions and the official TDH snapshot.
- `GET /collect/assets` searches the supported canonical catalog.
- `POST /collect/analyses` analyzes profile-wide exact, season, full-set, artist
  or Pebbles trait goals. Released and TDH-eligible universes are distinct.
- `GET /market/listings` pages observed low-price collection listings.
- `GET /market/orders` discovers supported exact listings or offers for one NFT.
- `POST /collect/plans` creates a private incremental acquisition plan;
  `POST /collect/plans/{id}/advance` checks the next batch. Refresh after a
  profile, catalog or recipient change. Asset-scan completion does not mean
  exhaustive market coverage or guaranteed executable inventory.
- `POST /collect/tdh-scenarios` projects an exact acquisition allocation.
- `POST /collect/tdh-ranking` compares the current listing pool or a saved plan,
  including the nonlinear basket effect on existing holdings. Cost estimates
  include gas reserves and never establish a guaranteed market-wide minimum.

## Prepare, authorize and recover

1. Send `POST /market/operations` with a UUID `Idempotency-Key`, exact asset,
   quantity, wallet, recipient, currency and economic terms. Preserve that key
   across transport retries. Changed terms require a new key.
2. Independently validate the returned order or transaction. Show actual fees,
   NFT recipient, total price, seller net, expiry and spender/approval scope.
3. Use `/continue` to recheck ownership, approvals, order counter, recipient
   membership and simulation. A new order must reach `AWAITING_SIGNATURE`
   before signing its EIP-712 payload. The wallet remains the only signer.
4. Before any transaction wallet request, persist a unique attempt locally and
   call `/send-attempts` with the reviewed revision, purpose and exact transaction
   digest. Wait for acknowledgement before opening the wallet. This atomically
   records `UNKNOWN` and blocks another send for the operation across clients.
5. Post its signature to `/signature`, or the exact sent transaction hash to
   `/submissions`. A signature is a bearer capability: do not log or retain it
   in analytics. The server does not accept arbitrary wallet transactions.
6. Read `/market/operations/{id}` to reconcile. `UNKNOWN` requires recovery of
   the original order/transaction, never blind resubmission. List history with
   the opaque cursor from `/market/me/operations`.

The optional `send_attempt` exposes the exact pending action for recovery even
without local storage. `/submissions` also accepts an approval hash for that
attempt and verifies its sender, target, calldata, value and canonical receipt.
An unknown send never expires merely because a timer or connection fails.
`/send-attempts/rejection` can release only the matching attempt after an explicit
wallet rejection or when the wallet request was never invoked. It must never
be used for an ambiguous wallet/RPC response. Keep retrying a lost acknowledgement
with the same attempt ID; do not create a replacement attempt.

An order freshness timer does not invalidate a revealed signature. Potential
offer liability starts before signable terms leave the server and persists
through publication uncertainty, balance changes and revoked approvals.
Verified safe-chain fill, expiry or cancellation can reduce it. Transaction
receipts must match a payload previously reviewed for that specific operation;
the same transaction cannot be attributed to two operations.

## Saved rules

Create a rule with `POST /collect/rules` and a UUID `Idempotency-Key`. Freeze
exact artwork targets and quantities, unit price ceilings, paying wallet,
recipient, lifetime review budget, per-review gas ceiling, expiry and action
count. Optional plan/analysis references must identify the same owned plan.

`POST /collect/rules/{id}/prepare` accepts an exact native-ETH purchase under
those limits and returns a reviewed operation. It neither signs nor broadcasts.
Continue through the ordinary wallet flow, then call `/reconcile` to apply
verified receipt quantities and actual gas once. Acquired quantities are
monotonic; transferring or selling an acquired item does not restart the goal.

Pause or resume with `/pause` and the expected revision. An outstanding review
survives pause, expiry and quote timeout. Recovery must establish its actual
outcome before preparing another purchase. Limits govern this site's preparation
workflow; they do not enforce arbitrary external wallet activity or create an
on-chain autonomous spending mandate.

## Release and operation

Required deployment order: `dbMigrationsLoop`, `api`, then the frontend.
Existing catalog, ownership and TDH ingestion services supply the data and do
not change in this release. Confirm fresh catalog/holdings/TDH sources before
declaring their corresponding UI healthy. The trading kill switch preserves
history and direct cancellation; do not delete liability/history tables during
rollback. Live-value testing requires separate explicit transaction authority;
fork proofs and production read/prepare smoke checks do not spend user funds.
