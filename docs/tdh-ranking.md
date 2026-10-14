# TDH ranking parity

Backend and native Core calculations use the same ordinal ranking rules. All
numeric fields below sort descending. A complete tie sorts by lowercase wallet
address for raw rows, or lowercase consolidation key for consolidated rows,
ascending with plain string comparisons. Equality returns zero. Input query
order, previous sorts and locale must not determine the winner of a tie.

| Rank | Numeric criteria, in order |
| --- | --- |
| Overall wallet or consolidation | Boosted TDH, TDH, Gradients TDH, NextGen TDH |
| Memes, Gradients or NextGen wallet/consolidation | Collection boosted TDH, collection TDH, collection balance, total balance |
| Owners of an individual Meme card | That card's TDH, total boosted TDH |

Overall ranks are consecutive positions beginning at one. A collection rank is
`-1` when its boosted collection TDH is zero. Individual Gradient/NextGen token
ranks retain their existing token-level criteria: token TDH descending, numeric
token ID ascending. Equal numeric IDs and scores compare as equal.

The backend's raw TDH row inclusion rule is unchanged: retain a wallet when its
TDH is positive, its eligible NFT balance is positive, or its resolved
consolidation has more than one wallet. Empty singleton candidates are omitted.
Core must use the same rule before ranking. Legitimate zero-score funded wallets
and members of a consolidation remain included. This rule does not delete
profiles, ownership, delegations or consolidation links. A normal full Core TDH
calculation replaces its derived TDH rows and removes previously included empty
singleton candidates.

Both full TDH calculation and on-demand reconsolidation call `calculateRanks`.
Partial calculations rank the complete current universe, rebuild per-token rank
arrays, and persist the resulting rank shifts for unchanged wallets/groups too.
Only the requested wallets and their exact previous consolidation keys are
deleted before upserting those rows; unaffected scores and memberships are
retained. Partial calculations build token-level ranking catalogs from all
current rows rather than only the recalculated subset.
Persisting global rank shifts increases partial-refresh work. Check duration and
memory with a representative staging reconsolidation before production rollout;
the saved-data comparison validates rank values, not Lambda runtime cost.
Rank ordering changes do not change holdings, TDH scoring, boosts or Merkle leaf
values. The correction can reorder displayed positions for tied wallets and
correct collection positions previously affected by the missing lower-total-
balance comparison.

To validate runtime parity, first deploy `delegationsLoop` and `tdhLoop` with the
same backend source, rebuild Core, then calculate both at the same block and
policy. Compare row membership, overall/collection/per-token ranks, scores and
Merkle roots. Deployment alone does not rewrite previously calculated ranks.

## Help knowledge authoring facts

- Equal TDH does not necessarily mean equal rank: the remaining scoring
  criteria are compared first, then the canonical wallet address or
  consolidation key determines the position of a complete tie.
- TDH ranks are ordinal positions; tied scores do not receive a shared rank.
- Empty singleton wallets do not enter the TDH ranking universe. Consolidated
  members and funded zero-score wallets remain eligible for overall positions.
- A collection rank of `-1` means the wallet/consolidation has no positive
  boosted TDH for that collection.

These backend-owned facts are source material for the frontend help corpus;
this document is not a new live help-bot knowledge source.
