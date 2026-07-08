# Group Eligibility Rule Specification

```yaml
spec_version: 1
status: normative
scope: user-group (community-group) membership / eligibility evaluation
```

This document is the versioned rule specification for deciding whether an
identity (profile) is **eligible for** (equivalently: **a member of**) a user
group. It is the conformance contract for every implementation of the rules,
current and future:

- the **in-memory engine**: `UserGroupsService.whichOfGivenGroupsIsUserEligibleFor`
  (`src/api-serverless/src/community-members/user-groups.service.ts`) driven by
  the predicates in `src/groups/user-group-predicates.ts`;
- the **set-based SQL engine**: `UserGroupsService.getSqlAndParams` (and helpers
  `getGeneralPart`, `getRepPart`, `getCicPart`, `getTypeOfNftPart`,
  `getBeneficiaryOwnersPart`, `getInclusionExclusionPart` in the same file),
  which generates a member-set query per group;
- future implementations: the materialized membership engine and, eventually,
  decentralized client nodes evaluating the same rule set as a protocol
  artifact.

Where the two existing implementations disagree, the disagreement is recorded
verbatim in [§12 Open divergences pending decision](#12-open-divergences-pending-decision).
Unless stated otherwise, the **normative behavior is the in-memory engine's**;
divergences are *pinned, not hidden*, by the conformance harness
(`src/tests/eligibility-conformance/`) and await an explicit product decision.
Nothing in this document changes production behavior.

## Table of contents

1. [Evaluation model](#1-evaluation-model)
2. [Group rule fields](#2-group-rule-fields)
3. [TDH bounds](#3-tdh-bounds)
4. [Level bounds](#4-level-bounds)
5. [Rep bounds](#5-rep-bounds)
6. [CIC bounds](#6-cic-bounds)
7. [NFT ownership](#7-nft-ownership)
8. [Grant beneficiary](#8-grant-beneficiary)
9. [Explicit identity lists](#9-explicit-identity-lists)
10. [Visibility and privacy](#10-visibility-and-privacy)
11. [Determinism rules](#11-determinism-rules)
12. [Open divergences pending decision](#12-open-divergences-pending-decision)
13. [Changelog](#13-changelog)

---

## 1. Evaluation model

Eligibility is a **pure function** of two inputs:

1. the **group rule** — one row of `community_groups`
   (`UserGroupEntity`, `src/entities/IUserGroup.ts`), and
2. the **profile state** — the facts about one identity at evaluation time:
   - identity metrics: `identities.tdh`, `identities.xtdh`,
     `identities.level_raw`, `identities.rep`, `identities.cic`
     (`src/entities/IIdentity.ts`);
   - ratings rows involving the profile (`ratings` table,
     `src/entities/IRating.ts`);
   - NFT ownership of the profile's consolidated wallets (`nft_owners` joined
     through `address_consolidation_key` on `identities.consolidation_key`);
   - external-collection token ownership (`external_indexed_ownership_721`,
     also consolidation-resolved) together with xTDH grant definitions
     (`xtdh_grants`, `xtdh_grant_tokens`);
   - explicit list memberships (`profile_groups` rows keyed by
     `profile_group_id`).

The result for a set of groups is the subset of group ids the profile is
eligible for. There is no ordering requirement: results are a **set**.

### 1.1 Top-level algorithm

Normative order of evaluation, per
`whichOfGivenGroupsIsUserEligibleFor` and
`eliminateBannedGroupsAndGroupRestByInByIdentityAndNeedsAdditionalCheck`:

1. **Candidate filter**: only groups with `visible = 1` are candidates at all
   (see [§10](#10-visibility-and-privacy)).
2. **Ban (exclusion) precedence**: if the profile is in the group's exclusion
   list (`profile_groups.profile_group_id = group.excluded_profile_group_id`),
   the group is removed from consideration. **Exclusion overrides everything**,
   including presence in the inclusion list and criteria matches.
3. **Identity-membership shortcut**: if the (non-banned) profile is in the
   group's inclusion list (`profile_groups.profile_group_id =
   group.profile_group_id`), it is eligible **regardless of any criteria** on
   the group. Criteria are never evaluated for such a profile. (Verified: the
   shortcut set is appended to the result unconditionally and those groups are
   excluded from the criteria pipeline.)
4. **Criteria evaluation**: the remaining non-banned groups that carry at least
   one non-identity condition (`hasGroupGotAnyNonIdentityConditions`: any of
   the owns-flags, `tdh_min/max`, `level_min/max`, `rep_min/max`, `cic_min/max`,
   `cic_user`, `rep_user`, `rep_category`, `is_beneficiary_of_grant_id`) are
   evaluated. **All configured criteria must pass (logical AND)** across
   [§3](#3-tdh-bounds)–[§8](#8-grant-beneficiary).
5. **Exclusion-only groups**: a non-banned group with **no inclusion list, no
   criteria, but an exclusion list** admits everyone who is not excluded
   (`groupsWhereUserIsInJustByMissingExclusion`). See [§9.3](#93-exclusion-only-groups).
6. A group with **no criteria, no inclusion list and no exclusion list**
   matches nobody in the in-memory engine. The SQL engine says *everyone* —
   this is divergence [D-7](#d-7-empty-group-no-criteria-no-lists).

### 1.2 Bounds primitive

All numeric window checks reduce to `isRatingOutOfBounds`
(`src/groups/user-group-predicates.ts`):

```
inBounds(min, max, real) := (min = null ∨ real ≥ min) ∧ (max = null ∨ real ≤ max)
```

with one modifier, `minMaxNullMeansNonZeroRequired`:

- **true** (used for all *granular* rating checks: by-user rep/cic,
  by-category rep, by-user+category rep, total-sent rep/cic): when `min` and
  `max` are **both null**, the real value must be **non-zero**. That is,
  configuring a rep/cic filter with a user and/or category but no bounds means
  "has non-zero total on that axis".
- **false** (used for profile-level metrics: tdh, level, total-received rep and
  cic): both-null bounds are unbounded (always pass).

Bounds are inclusive on both ends.

## 2. Group rule fields

The full rule field set of `UserGroupEntity` (`community_groups` table):

| Field | Type | Meaning |
|---|---|---|
| `tdh_min`, `tdh_max` | bigint, nullable | TDH window ([§3](#3-tdh-bounds)) |
| `tdh_inclusion_strategy` | `TDH \| XTDH \| BOTH`, default `TDH` | which TDH metric ([§3](#3-tdh-bounds)) |
| `level_min`, `level_max` | bigint, nullable | **level numbers**, not raw scores ([§4](#4-level-bounds)) |
| `rep_min`, `rep_max` | bigint, nullable | rep window ([§5](#5-rep-bounds)) |
| `rep_user` | profile id, nullable | rep counterparty filter ([§5.2](#52-by-user-by-category-by-usercategory)) |
| `rep_category` | string, nullable | rep category filter ([§5.2](#52-by-user-by-category-by-usercategory)) |
| `rep_direction` | `RECEIVED \| SENT`, nullable (default `RECEIVED`) | rep direction |
| `cic_min`, `cic_max` | bigint, nullable | cic window ([§6](#6-cic-bounds)) |
| `cic_user` | profile id, nullable | cic counterparty filter |
| `cic_direction` | `RECEIVED \| SENT`, nullable (default `RECEIVED`) | cic direction |
| `owns_meme`, `owns_gradient`, `owns_lab`, `owns_nextgen` | bool, nullable | per-collection ownership flags ([§7](#7-nft-ownership)) |
| `owns_meme_tokens`, `owns_gradient_tokens`, `owns_lab_tokens`, `owns_nextgen_tokens` | JSON string array, nullable | required token-id lists ([§7](#7-nft-ownership)) |
| `owns_meme_tokens_match_mode`, `owns_gradient_tokens_match_mode`, `owns_lab_tokens_match_mode`, `owns_nextgen_tokens_match_mode` | `ANY_TOKEN \| ALL_TOKENS`, default `ALL_TOKENS` | token-list match mode ([§7.2](#72-token-lists-and-match-modes)) |
| `is_beneficiary_of_grant_id` | grant id, nullable | xTDH grant beneficiary criterion ([§8](#8-grant-beneficiary)) |
| `is_beneficiary_of_grant_match_mode` | `ANY_TOKEN \| ALL_TOKENS`, default `ANY_TOKEN` | grant match mode ([§8](#8-grant-beneficiary)) |
| `profile_group_id` | list id, nullable | inclusion list ([§9](#9-explicit-identity-lists)) |
| `excluded_profile_group_id` | list id, nullable | exclusion list ([§9](#9-explicit-identity-lists)) |
| `visible` | bool | candidate gate ([§10](#10-visibility-and-privacy)) |
| `is_private` | bool | access control only, not an eligibility rule ([§10](#10-visibility-and-privacy)) |

A null bound means "unbounded on that side" (subject to §1.2's non-zero
modifier where applicable).

## 3. TDH bounds

Sources: `isProfileTdhOutOfGroupsBounds` + `getTdhMetricFromProfile`
(in-memory); `getGeneralPart` + `getIdentitySideTdhPart` (SQL).

The compared metric depends on `tdh_inclusion_strategy`:

| Strategy | In-memory metric (`getTdhMetricFromProfile`) | SQL expression |
|---|---|---|
| `TDH` | `identities.tdh` (already an integer column) | `i.tdh` |
| `XTDH` | `floor(identities.xtdh)` | `i.xtdh` (raw double) |
| `BOTH` | `floor(identities.tdh + identities.xtdh)` | `i.tdh + i.xtdh` (raw) |

Rule: profile passes iff `inBounds(tdh_min, tdh_max, metric)` with
`minMaxNullMeansNonZeroRequired = false`. `tdh = 0` therefore passes
`tdh_min = 0`.

**Integer-only comparison is a spec-level rule**: `identities.xtdh` is a
`double`, but any xTDH contribution to the eligibility metric **floors to an
integer** before comparison. Group bounds are integers (bigint columns).
Conforming implementations MUST compare integers only; no fractional TDH may
influence eligibility. The SQL engine currently compares the raw double, which
diverges from this rule exactly when the metric is fractional and
`tdh_max = floor(metric)` — see [D-2](#d-2-fractional-xtdh-vs-tdh_max).
(`tdh_min` cannot diverge: for fractional `x` there is no integer in
`(floor(x), x]`.)

## 4. Level bounds

`level_min` / `level_max` store **LEVEL NUMBERS** (0–100), not raw scores.
Levels are derived from `identities.level_raw` via the fixed table in
`src/profiles/profile-level.ts`: `getLevelFromScore(score)` returns the highest
level whose border (`minTdh`) is ≤ score; scores below 25 (including negative
scores) are level 0. `getLevelComponentsBorderByLevel(level)` returns that
level's lower border (level 0 → 0, 1 → 25, 2 → 50, 3 → 100, 4 → 250, …;
inputs < 0 return themselves; inputs > 100 return `Number.MAX_SAFE_INTEGER`).

The two engines intentionally *approach* the same rule differently — **both
are documented; they do not agree on `level_max`**:

- **In-memory** (`whichOfGivenGroupsIsUserEligibleFor` →
  `isProfileLevelOutOfGroupsBounds`): derives
  `level = getLevelFromScore(identities.level_raw)` and requires
  `inBounds(level_min, level_max, level)` — a comparison **between level
  numbers**.
- **SQL** (`getSqlAndParams` → `getGeneralPart`): converts each bound to its
  raw border via `getLevelComponentsBorderByLevel(bound)` and compares the raw
  score: `i.level_raw >= border(level_min)` and
  `i.level_raw <= border(level_max)`.

For `level_min` the encodings coincide: `level ≥ N ⟺ level_raw ≥ border(N)`.

For `level_max` they do **not**: level N spans
`[border(N), border(N+1))`, so a profile whose `level_raw` lies strictly
between `border(level_max)` and `border(level_max + 1)` **is** at level
`level_max` (in-memory: pass) but has `level_raw > border(level_max)` (SQL:
fail). Example: `level_max = 3` (border 100), `level_raw = 150` → level 3 →
in-memory eligible, SQL not a member. This is **KNOWN DIVERGENCE
[D-1](#d-1-level_max-inside-band)** — recorded, not fixed.

`minMaxNullMeansNonZeroRequired = false`: a level-0 profile passes
`level_min = 0`.

Additionally the SQL builder drops **zero-valued** level bounds entirely
(truthiness check `group.level.min ? … : null`). For `level_min = 0` this is
harmless (everyone is at least level 0 — engines agree); for `level_max = 0`
it diverges ([D-3](#d-3-zero-bounds-dropped-by-the-sql-builder)).

## 5. Rep bounds

Rep criteria come in five shapes, selected by which of `rep_user` /
`rep_category` are set and by `rep_direction`
(default **`RECEIVED`** via `getUserGroupDirectionOrDefault`).

Only rows with `ratings.matter = 'REP'` count. **`WAVE_REP` is excluded**: the
in-memory predicates filter `matter === RateMatter.REP` explicitly, the
in-memory total-sent aggregator (`UserGroupsDb.getGivenCicAndRep`) only adds
`CIC` and `REP` matters, and every generated SQL rating subquery filters
`matter = 'REP'` (or `'CIC'`). Category comparison is **case-sensitive**
(binary): JS `===` in-memory; `ratings.matter_category` has binary collation
(`utf8_bin`) in SQL.

### 5.1 Total rep (no user, no category)

- **Direction `RECEIVED`** (`hasGroupGotProfileRepCriteria`): compares the
  identity's aggregated `identities.rep` column,
  `minMaxNullMeansNonZeroRequired = false`. State invariant assumed:
  `identities.rep = Σ rating` over `matter='REP'` rows received by the
  profile (all categories, all raters, WAVE_REP excluded).
- **Direction `SENT`** (`hasGroupGotTotalSentRepCriteria` →
  `isProfileViolatingTotalSentRepCriteria`): compares the sum of all `REP`
  ratings the profile has **given** (`getGivenCicAndRep`),
  `minMaxNullMeansNonZeroRequired = true`.
- SQL: aggregates the `ratings` table (`sum(rating)` grouped by the
  direction-side profile with `rating <> 0` row filter) and **requires the
  profile to appear in the aggregate** (inner join) — see
  [D-4](#d-4-sql-requires-rating-existence) — and drops zero-valued bounds —
  see [D-3](#d-3-zero-bounds-dropped-by-the-sql-builder).

### 5.2 By user, by category, by user+category

Granular checks are evaluated against the profile's rating rows
(`isGroupViolatingAnySpecificRepCriteria`), all with
`minMaxNullMeansNonZeroRequired = true`:

- **by-user** (`rep_user` set, `rep_category` null): real =
  Σ ratings between the profile and `rep_user` in the configured direction,
  `matter = REP`, **summed across all categories**;
- **by-category** (`rep_category` set, `rep_user` null): real = Σ ratings in
  that exact category in the configured direction across all counterparties;
- **by-user+category** (both set): real = the rating between the profile and
  `rep_user` in that exact category and direction.

Direction: `RECEIVED` means the profile is the rating target and the
counterparty is the rater; `SENT` means the profile is the rater.

Null-min-and-max ⇒ **non-zero required**: e.g. `rep_user = alice` with no
bounds means "alice's net rep on the profile is non-zero" (direction-adjusted).

SQL encodes by-user rep as per-`(profile, category)` aggregates and admits a
profile when **any single category row** satisfies the bounds, while the
in-memory rule sums across categories — divergence
[D-5](#d-5-by-user-rep-per-category-vs-cross-category-sum). Existence-vs-zero
also applies ([D-4](#d-4-sql-requires-rating-existence)).

## 6. CIC bounds

CIC has no category axis; shapes are total and by-user, with direction
defaulting to `RECEIVED`.

- **Total received** (`hasGroupGotProfileCicCriteria`): compares
  `identities.cic`, `minMaxNullMeansNonZeroRequired = false`. Invariant:
  `identities.cic = Σ rating` over `matter='CIC'` rows targeting the profile.
- **Total sent** (`hasGroupGotTotalSentCicCriteria`): compares
  Σ `CIC` ratings given by the profile, non-zero-required semantics.
  The SQL builder **ignores `cic_direction` when `cic_user` is null** and
  always aggregates received CIC — divergence
  [D-6](#d-6-total-cic-direction-forced-to-received-in-sql).
- **By-user** (`cic_user` set): real = Σ CIC ratings between profile and
  `cic_user` in the configured direction; null-null bounds ⇒ non-zero
  required. (CIC rows are singletons per rater/target pair, so the per-category
  splitting issue of [D-5](#d-5-by-user-rep-per-category-vs-cross-category-sum)
  does not arise.)

CIC values may be negative; bounds are signed integers.
Zero-valued `cic_min`/`cic_max` (with no `cic_user`) are dropped by the SQL
builder ([D-3](#d-3-zero-bounds-dropped-by-the-sql-builder)).

## 7. NFT ownership

Sources: `isProfileViolatingOwnsCriteria` /
`isProfileHavingContractTokenOwningsMisMatch` (in-memory);
`getTypeOfNftPart` + ownership joins in `getGeneralPart` (SQL).

Four collections, each bound to a fixed contract:

| Flag | Contract |
|---|---|
| `owns_meme` | `MEMES_CONTRACT` `0x33FD426905F149f8376e227d0C9D3340AaD17aF1` |
| `owns_gradient` | `GRADIENT_CONTRACT` `0x0c58ef43ff3032005e472cb5709f8908acb00205` |
| `owns_lab` | `MEMELAB_CONTRACT` `0x4db52a61dc491e15a2f78f5ac001c14ffe3568cb` |
| `owns_nextgen` | `NEXTGEN_CORE_CONTRACT[mainnet]` `0x45882f9bc325E14FBb298a1Df930C43a874B83ae` |

Ownership is resolved across the identity's **whole consolidation**:
`nft_owners.wallet` → `address_consolidation_key.address` →
`identities.consolidation_key`. Contract and token-id comparisons are
case-insensitive (in-memory lowercases both sides; MySQL collation is
accent/case-insensitive for these columns).

### 7.1 Per-collection rule

A collection contributes a criterion only when its flag is truthy. Multiple
flagged collections are **ANDed**. For a flagged collection:

1. If the profile owns **zero tokens** of the contract ⇒ **not eligible**,
   regardless of match mode and regardless of the token list (even an empty
   list). (`profilesCollectionOwnings.length === 0 → mismatch`.)
2. If the token list (`owns_*_tokens`, a JSON string array like
   `'["100","201"]'`) is **null or empty** ⇒ owning **any token** of the
   collection satisfies the criterion.
3. Otherwise the list is matched per `owns_*_tokens_match_mode`
   (`GroupNftOwnershipMatchMode`, default **`ALL_TOKENS`** — both the column
   default and the code-level fallback for null/missing values):

### 7.2 Token lists and match modes

- **`ALL_TOKENS`** (default): the profile must own **every** token id in the
  list. In-memory: `neededTokens.some(t => !owned.has(t))` ⇒ mismatch. SQL:
  `HAVING COUNT(DISTINCT owned ∩ needed) = COUNT(*)` of the JSON list — note
  the right-hand side counts **duplicates** in the list, producing divergence
  [D-8](#d-8-all_tokens-with-duplicate-token-ids-in-the-list) for degenerate
  lists with repeated ids.
- **`ANY_TOKEN`**: the profile must own **at least one** token id in the list.
  In-memory: `neededTokens.every(t => !owned.has(t))` ⇒ mismatch (i.e. one hit
  suffices). SQL: inner join of owned tokens to the JSON list.

For single-token lists the two modes coincide.

Token ids are compared as strings of decimal token numbers; implementations
must treat `nft_owners.token_id` (numeric) and JSON list entries (strings) as
the same value space.

## 8. Grant beneficiary

Sources: `eliminateGroupsByBeneficiaryGrants` →
`UserGroupsDb.findBeneficiaryGrantGroupIdsForProfile` (in-memory pipeline —
note this check is itself SQL-backed); `getBeneficiaryOwnersPart` (member-set
SQL). Semantics are specified from that SQL.

A group with `is_beneficiary_of_grant_id = G` requires the profile to be a
**beneficiary** of xTDH grant `G`, interpreted through
`is_beneficiary_of_grant_match_mode` (`GroupBeneficiaryGrantMatchMode`,
default **`ANY_TOKEN`**). Grant `G` (row of `xtdh_grants`) contributes only
when `status = 'GRANTED'`; any other status (`PENDING`, `FAILED`, `DISABLED`)
⇒ nobody qualifies through it. Ownership is read from
`external_indexed_ownership_721` rows for the grant's `target_partition`,
consolidation-resolved to the profile.

Matrix over the grant's `token_mode` (`XTdhGrantTokenMode`):

| Grant `token_mode` | Group match mode `ANY_TOKEN` | Group match mode `ALL_TOKENS` |
|---|---|---|
| `ALL` (whole partition granted) | profile owns **≥ 1 token** in the grant's partition | **nobody** (the SQL disables this branch with `and 1 = 0`; the profile-side query has no matching branch) |
| `INCLUDE` (explicit token set in `xtdh_grant_tokens` keyed by `tokenset_id` + `target_partition`) | profile owns **≥ 1 of the granted token ids** | profile owns **every distinct granted token id** (`HAVING COUNT(DISTINCT owned granted tokens) = COUNT(DISTINCT tokenset tokens)`) |

Tokens in the partition that are **not** part of an `INCLUDE` grant's token
set never count. `save()` refuses to create `ALL_TOKENS` groups over
`ALL`-mode grants (and over missing grants), but the evaluation rule above is
still defined for such rows: they match nobody, consistently in both engines.

## 9. Explicit identity lists

Lists are rows of `profile_groups` (`profile_group_id`, `profile_id`).
A group references at most one inclusion list (`profile_group_id`) and one
exclusion list (`excluded_profile_group_id`).

### 9.1 Inclusion (identity-membership shortcut)

Profile in the inclusion list of a visible group ⇒ **eligible, criteria are
not evaluated** (in-memory: `getGroupsUserIsEligibleByIdentity` joins
`ug.visible = 1` and short-circuits; SQL: the inclusion list is `UNION ALL`ed
with the criteria-matching set in `getInclusionExclusionPart`). The two
encodings agree: inclusion ∪ criteria-matches, minus exclusions.

### 9.2 Exclusion (ban precedence)

Profile in the exclusion list ⇒ **not eligible, full stop** — even if it is
also in the inclusion list and/or passes every criterion. In-memory the banned
groups are removed before anything else
(`eliminateBannedGroupsAndGroupRestByInByIdentityAndNeedsAdditionalCheck`);
in SQL the exclusion is applied as the outermost `not in (…)` filter over the
union of inclusion and criteria matches.

### 9.3 Exclusion-only groups

A group with **no inclusion list and no criteria but with an exclusion list**
means "everyone except the excluded" (in-memory:
`groupsWhereUserIsInJustByMissingExclusion` routes such groups through the
(trivially passing) criteria pipeline; SQL: the base set falls back to all of
`identities`, minus exclusions). Both engines agree.

### 9.4 Degenerate empty group

No criteria, no inclusion, no exclusion: in-memory **nobody** is eligible; the
generated SQL view contains **every identity**. Divergence
[D-7](#d-7-empty-group-no-criteria-no-lists).

## 10. Visibility and privacy

- `visible = 1` is a hard precondition for eligibility: the in-memory engine
  only loads visible groups as candidates (`UserGroupsDb.getByIds` filters
  `visible = true`; the identity-shortcut query joins `ug.visible = 1`). An
  invisible group is eligible to nobody. The member-set SQL path
  (`getSqlAndParamsByGroupId` → `getByIdOrThrow` → `UserGroupsDb.getById`)
  does **not** check `visible` (it only enforces the privacy gate), so it
  builds a fully populated member set for an invisible group — divergence
  [D-9](#d-9-member-set-sql-ignores-the-visibility-gate).
- `is_private` is **not** an eligibility rule; it gates who may *see* the
  group definition through the API (`UserGroupsDb.getById` returns private
  groups only to their creator or to already-eligible identities).

## 11. Determinism rules

These rules make evaluation reproducible across independent node
implementations:

1. **Pure function**: eligibility depends only on (group rule, profile state)
   as defined in §1. No wall clock, no randomness, no environment. (Grant
   validity windows `valid_from`/`valid_to` are **not** part of the rule —
   only `status = 'GRANTED'` matters; status transitions are upstream state
   changes.)
2. **Integer math only**: all compared metrics and bounds are integers.
   Fractional xTDH floors to an integer before comparison (§3). No
   floating-point comparison may decide eligibility.
3. **Set semantics**: the result is an unordered set of group ids; conformance
   assertions must be order-insensitive.
4. **Binary string comparison** for identifiers and rep categories
   (case-sensitive), **case-insensitive** comparison for wallet addresses,
   contract addresses and token ids, which are normalized to lowercase.
5. **Inclusive bounds**; null = unbounded; the both-null non-zero-required
   modifier applies exactly to the check shapes listed in §1.2.
6. **AND composition**: all configured criteria dimensions must pass; the
   inclusion shortcut and exclusion precedence of §9 are the only overrides,
   applied in the order: exclusion ≻ inclusion ≻ criteria.
7. **State invariants assumed**: `identities.rep` / `identities.cic` /
   `identities.tdh` / `identities.level_raw` equal the documented aggregations
   of the underlying facts. Implementations that recompute from raw facts and
   implementations that read the aggregates must agree provided the
   invariants hold. The conformance vectors always seed consistent state.

## 12. Open divergences pending decision

Each divergence below is pinned by conformance vectors marked with
`knownDivergence.sql` in `src/tests/eligibility-conformance/vectors/`; the
SQL-side harness asserts the **divergent** outcome so any drift in either
engine is caught. **None of these are fixed by this spec**; each needs a
product decision, after which the losing engine gets patched and the vector's
`knownDivergence` marker removed (bumping `spec_version`).

### D-1: `level_max` inside band

- **Rule**: §4. Group `level_max = N`; profile `level_raw` in
  `(border(N), border(N+1))`, i.e. level exactly `N` but above the level's
  lower border.
- **In-memory**: eligible (level `N ≤ N`). **SQL**: not a member
  (`level_raw > border(N)`).
- Vector: `level-max-inside-level-divergence` (level_max 3, level_raw 150).

### D-2: fractional xTDH vs `tdh_max`

- **Rule**: §3. Strategy `XTDH` or `BOTH` with fractional metric `x` and
  `tdh_max = floor(x)`.
- **In-memory**: eligible (compares `floor(x)`). **SQL**: not a member
  (compares raw double `x > tdh_max`).
- Vectors: `xtdh-fractional-max-divergence` (xtdh 100.5, max 100),
  `both-strategy-sum-and-fractional-max-divergence` (tdh 60 + xtdh 40.5, max 100).

### D-3: zero bounds dropped by the SQL builder

- **Rule**: §§4–6. The SQL builder's guards use JS truthiness, so **zero**
  bounds vanish from the generated SQL: `getRepPart` / `getCicPart` outer
  guards (`rep_min/rep_max/cic_min/cic_max = 0` with no user/category) and the
  level border conversion (`level_min/level_max = 0`). The in-memory engine
  treats 0 as a real bound (`!== null` checks).
- **In-memory**: bound enforced (e.g. `cic_min = 0` rejects negative CIC;
  `level_max = 0` admits only level 0). **SQL**: bound silently dropped
  (everyone passes that axis).
- Agreeing exceptions: `level_min = 0` (vacuous either way) and
  `tdh_min/tdh_max = 0` (the TDH guards use `!== null`).
- Vectors: `cic-min-zero-divergence`, `rep-min-zero-divergence`,
  `level-max-zero-divergence` (+ agree-vector `level-min-zero-noop`).

### D-4: SQL requires rating existence

- **Rule**: §§5–6. Every generated rep/cic subquery feeds an **inner join**,
  so a profile qualifies only if it has ≥ 1 rating row (`rating <> 0`) in the
  configured scope/direction. The in-memory engine evaluates the bounds
  against a real value of 0 when there are no rows (or against the identity
  aggregate columns for received totals).
- Divergent whenever 0 satisfies the bounds but no row exists: max-only
  windows, negative or zero minimums.
- **In-memory**: eligible. **SQL**: not a member.
- Vectors: `rep-total-max-only-no-ratings-divergence`,
  `cic-by-user-negative-min-no-ratings-divergence`.

### D-5: by-user rep — per-category vs cross-category sum

- **Rule**: §5.2. `rep_user` set, `rep_category` null. In-memory sums the
  counterparty's REP across **all categories**; the SQL groups per
  `(profile, category)` and admits the profile when **any one category row**
  fits the bounds.
- Example A (bounds `min = 3`): alice → profile `+5 "artist"`, `-5 "dev"`.
  In-memory total `0 < 3` ⇒ not eligible; SQL sees the `+5` row ⇒ member.
- Example B (bounds null-null, non-zero required): same rows. In-memory total
  `0` ⇒ not eligible; SQL: rows exist ⇒ member.
- Vectors: `rep-by-user-cross-category-min-divergence`,
  `rep-by-user-cross-category-net-zero-divergence`.

### D-6: total CIC direction forced to RECEIVED in SQL

- **Rule**: §6. With `cic_user = null` the SQL builder hardcodes the received
  direction (`getCicPart`: `cicGroup.user_identity ? direction ?? Received :
  Received`), ignoring `cic_direction = 'SENT'`. The in-memory engine honors
  SENT via `getGivenCicAndRep`. (The equivalent rep path honors direction on
  both sides.)
- **In-memory**: total **sent** CIC window. **SQL**: total **received** CIC
  window.
- Vector: `cic-total-sent-direction-divergence`.

### D-7: empty group (no criteria, no lists)

- **Rule**: §9.4. A visible group with every rule field null/false.
- **In-memory**: matches nobody (it is neither a criteria group, nor an
  inclusion/exclusion group, so it is filtered out of every admission path).
  **SQL**: `user_groups_view` degenerates to `select * from identities` —
  everyone is a member.
- Vector: `empty-group-divergence`.

### D-8: `ALL_TOKENS` with duplicate token ids in the list

- **Rule**: §7.2. Degenerate JSON list with a repeated token id, e.g.
  `'["100","100"]'`.
- **In-memory**: set semantics — owning token 100 suffices ⇒ eligible.
  **SQL**: `HAVING COUNT(DISTINCT owned) = COUNT(*) of JSON rows` — 1 ≠ 2 ⇒
  never a member.
- Vector: `nft-all-tokens-duplicate-list-divergence`.

### D-9: member-set SQL ignores the visibility gate

- **Rule**: §10. `visible = 0` groups are eligible to nobody in the in-memory
  engine (candidate loading filters them out), but
  `getSqlAndParamsByGroupId` → `UserGroupsDb.getById` checks only the privacy
  gate, so the generated member set for an invisible group is fully populated
  as if it were visible.
- **In-memory**: not eligible. **SQL**: members computed normally.
- Vector: `invisible-group-divergence`.

## 13. Changelog

| spec_version | Date | Changes |
|---|---|---|
| 1 | 2026-07-08 | Initial specification extracted from the in-memory predicates and the member-set SQL generator, including the new NFT-ownership match modes (`owns_*_tokens_match_mode`) and grant-beneficiary match mode (`is_beneficiary_of_grant_match_mode`). Divergences D-1…D-9 recorded as open. |
