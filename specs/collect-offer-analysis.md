# Per-NFT offer analysis

`POST /collect/offer-analyses` is a private, directly authenticated planning
endpoint. It does not create operations, reserve WETH, request approvals,
construct signatures, publish orders, or promise an atomic group fill. The API
deployable owns the endpoint. No new table or schema synchronization is needed.

The selected profile remains the collecting identity. The authenticated paying
wallet must belong to that profile; its own WETH balance funds its proposals.
Another profile wallet cannot contribute its balance. Proxy authentication and
wallet/profile substitution are rejected by the existing trading actor guard.
Offers currently require the paying wallet as recipient under the existing
single-offer validator. External recipients are rejected even if acknowledged.
This does not change the separate purchase recipient capabilities.

## Price methods

The request accepts up to 1,000 distinct exact NFT keys and positive canonical
integer quantities. ERC721 quantities must be one. Duplicate keys are rejected;
the caller must deduplicate overlapping collecting requirements before analysis.
Pebbles alternatives must be explicitly selected. Listing every alternative for
a trait would create independent potential acquisitions, not an either/or bid.

- `manual`: provide `manual_unit_amount_wei` for every NFT. A total budget alone
  never defines a manual price. In other modes the same field is an immutable
  manual pin.
- `match_bid`: use the highest applicable observed exact-token WETH unit bid.
- `improve_bid`: apply 0–100,000 integer basis points above that bid. Positive
  improvements round upward to the next wei, so a positive improvement does not
  disappear through rounding.
- `discount_ask`: apply 0–9,999 integer basis points below the lowest applicable
  observed ask. Discounts round downward. Native ETH asks carry an explicit
  ETH/WETH comparison reason, with no implied conversion or acceptance.
- `goal`: require an explicit new-commitment WETH budget. The versioned
  `conservative_opening_v1` policy preserves pins, then selects the maximum count
  of remaining supplied exact NFTs at fixed supported openings, preferring lower
  full-quantity commitments and stable NFT identity. It does not infer set,
  artist, trait, TDH, or alternative-token coverage beyond the supplied list.

The goal opening is 70% of the applicable gross ask only for ERC1155 NFTs with
at least three distinct observed ask makers and complete bounded indexed
coverage. Fewer than two distinct bid makers reduce the opening another 5%.
These are conservative product policy parameters, not calibrated valuations or
acceptance probabilities. Distinct addresses do not prove independent control.
There is no automatic price for sparse unique art, a bid-only market, or
incomplete goal evidence. Manual and explicit formula modes remain available.
No sale-comparable model or live-market depth guarantee is claimed.

## Evidence and freshness

Analysis uses bounded completed collection snapshots, including the existing
market event overlay for observed cancellations and other lifecycle changes.
It does not issue provider or RPC calls per NFT. References require active,
public, exact-token, supported fixed-price order terms, canonical currencies,
matching hash/maker/token identities and an exactly representable requested
quantity. Own-profile and paying-wallet makers are excluded. Unproven criteria,
unsupported terms and insufficient quantities do not produce a price.

An indexed `is_executable` flag is only an input to terms filtering. Reference
DTOs explicitly state `OBSERVED_NOT_CHAIN_VERIFIED`, `EXACT_TOKEN_TERMS`, and
funding `UNKNOWN`. Signature, live counter, maker funding, inventory, approval,
zone authorization, and fulfillment are not verified during analysis. The
reference is an observed benchmark, not an executable quote. “Highest” and
“lowest” mean within the bounded applicable indexed observations.

The conservative source age uses the older of snapshot start, completion and
order observation. References older than one hour or outside their validity
window are excluded. An analysis expires within sixty seconds, further bounded
by its references' source age and order expiry. Overall live-market coverage is
always incomplete; indexed coverage is reported separately. Missing or stale
data is explicit, never a zero price.

## Money and execution

All pricing uses BigInt wei and full requested quantities. `total_amount_wei`
equals unit amount times quantity, bounded by uint256. The corresponding
single-offer `prepare_request.amount_wei` is this total. Existing offer fees are
allocated inside that maximum gross debit during fresh review; a unit price
must never be passed as the total for a multi-copy NFT.

A fresh payer WETH balance is compared with primary-database tracked liabilities
across all profiles and unresolved states. Tracked liabilities are read with a
10,001-row sentinel and fail closed if coverage or numeric validity is unknown.
External signatures are not comprehensively known. Analysis capacity is the
nonnegative balance minus tracked liabilities, capped by the optional maximum
NEW group commitment. ETH gas is separate from WETH; this endpoint does not
estimate gas or earmark allowances.

Manual/formula budget or funding conflicts retain every explicit price and
quantity, flag the conflict, and expose no actionable prepare proposal. Goal
allocation may exclude optional NFTs to fit capacity, but never removes or
changes a manual pin to make the plan appear feasible. Invalid or unaffordable
pins require explicit user resolution. Unallocated WETH stays uncommitted.

Each selected proposal enters the existing single-offer preparation, fresh
review, funding check, liability reservation, explicit signature and publication
flow. Other tabs or external activity can change capacity between analysis and
review. Every offer can be accepted independently, including in an order that
never completes the collecting goal; proposed totals bound the aggregate debit
of these proposals, not every external signature a wallet has ever made.

The response includes authoritative catalog artwork metadata for supported
NFTs, reason codes, exact amounts and reference provenance. Analysis requests
and responses use private/no-store handling and existing market error/body
sanitization. No new analytics or persistent strategy records are introduced.
The frontend owns the corresponding Collect help-index documentation.
