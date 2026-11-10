# Sanctions list v1 (`6529.sanctions-list.v1`)

Status: draft for review, 2026-11-06. This spec defines how the sanctions list
is built, encoded, signed and checked. It is written once so that the backend
API, the website, the desktop signer and validators reach the same decision
from the same bytes.

The TypeScript reference implementation is `src/sanctions/`. Its test vectors
and fixtures are in [`sanctions-list-v1/`](sanctions-list-v1/). Another
implementation conforms when it passes every vector there.

The list contains official public sanctions data only, with no 6529 user data.

## 1. Sources

| Id | Authority | Input | Where addresses are read |
|---|---|---|---|
| `ca-sema` | Global Affairs Canada | `sema-lmes.xml` | No crypto field exists; parsed and scanned only |
| `ch-seco` | Swiss SECO | Consolidated list XML | Free text in the current `target/(entity\|individual\|object)`; `modification` history is ignored |
| `eu-fsf` | European Commission | FSF 1.1 XML | Free text of every element inside a `sanctionEntity` |
| `il-nbctf` | Israel MoD NBCTF | Delivery API JSON pages (`wallets-<skip>.json`, `orders-<skip>.json`) | `properties.walletAddress`, one listing per non-cancelled order linked by asset id |
| `jp-mof` | Japan MoF | `shisantouketsu<YYYYMMDD>.csv` (UTF-8, BOM) | Column `その他の情報` ("other information") only |
| `kr-fsc` | Korea FSC/KoFIU | `kr-fsc.pinned.json` (reviewed transcription) | The pinned entries |
| `uk-fcdo` | UK FCDO | `UK-Sanctions-List.xml` | Free text of every element inside a `Designation` |
| `us-ofac-sdn` | US Treasury OFAC | `SDN.XML` | `idList/id` whose `idType` starts with `Digital Currency Address - ` |

The exact URLs, list names and field mappings are in
`src/sanctions/sanctions-sources.ts` and the parser files. A parser's id
(for example `uk-fcdo-xml/1`) changes whenever its output could change.

**Korea is a pinned source.** The annex is a PDF or HWPX file whose URL changes
with each amendment, so a reviewed transcription with the document's sha256 is
committed instead. The fetch stage re-downloads the document and reports when
its sha256 no longer matches, so a human can update the transcription.

## 2. Addresses

- **EVM address.** `0x` followed by exactly 40 hexadecimal digits, compared
  in lower case. EIP-55 checksums are neither required nor verified: an
  authority's published bytes are matched as published.
- **Normalization (`normalizeEvmAddress`).** Trim ECMAScript whitespace,
  require `^0x[0-9a-fA-F]{40}$`, then lower-case. Anything else is not an
  address (`0X…` included).
- **Free-text extraction.** Find `0x` + 40 hex digits that are neither preceded
  nor followed by an ASCII letter or digit. A glued run such as
  `0x<40 hex>0x<40 hex>`, or a 64-digit transaction hash, therefore never
  matches.
- **Labels.** These are informational and never used for matching:
  - OFAC: the `idType` suffix (`ETH`, `USDT`, `USDC`, `ETC`, `ARB`, `BSC`).
  - Free text: an upper-case ticker of 2-6 characters written immediately
    before the address (`ETH: 0x…`, `- ETH 0x…`), looked for within the 24
    preceding characters.
  - Israel: `coinType`.
  - Korea: from the transcription.

## 3. The payload

The payload is JSON, serialized as described below. Field types are in
`src/sanctions/sanctions-list.types.ts`.

```text
{ schema: "6529.sanctions-list.v1", builder: "6529-sanctions-builder/1",
  chain_family: "evm",
  sources:   [ { id, authority, jurisdiction, list_name, nature, url,
                 acquisition, parser, inputs: [{name, sha256, bytes}],
                 source_published, evm_addresses, listings } ],
  addresses: [ { address, listings: [ { source, entry_id, entity, programs,
                 labels, listed_on, valid_until } ] } ],
  totals:    { addresses, listings, sources } }
```

**Determinism rules:**

1. **Encoding.** JSON Canonicalization Scheme (RFC 8785): object keys sorted by
   UTF-16 code units, no insignificant whitespace, strings escaped as
   ECMAScript `JSON.stringify` does, UTF-8 bytes. Only null, booleans, safe
   integers, strings, arrays and plain objects are allowed. Floats, lone
   surrogates and `undefined` are errors, never coerced.
2. **Sort order.**
   - `sources` by `id`.
   - `addresses` by address.
   - `listings` by (`source`, `entry_id`).
   - `programs` and `labels` de-duplicated and sorted by Unicode code point.
     This order equals UTF-8 byte order.
3. **Text.** Names, programmes, labels and entry ids are NFC-normalized, every
   run of ECMAScript whitespace (`\s`) becomes one space, and the result is
   trimmed. An empty result is null.
4. **Merging.** One listing exists per (address, source, entry). When a source
   yields the same triple more than once, the copies merge:
   - programmes and labels are united;
   - `entity` and `listed_on` take the smallest non-null value;
   - `valid_until` takes null (open-ended) if any copy is null, otherwise the
     latest date.
5. **No clock.** No fetch or build time appears in the payload. Dates come from
   the inputs:
   - `source_published`:
     - OFAC: `Publish_Date`.
     - UK: `DateGenerated`.
     - EU: `generationDate`.
     - SECO: root `date`.
     - Japan: the file-name date.
     - Korea: the notice date.
     - Israel: the newest order date.
     - Canada: the newest listing date.
   - `valid_until` is copied, never compared with "today".
6. **Inputs.** Each source records the sha256 and size of every input file. The
   build fails unless every source is present exactly once.

**Pure function.** `build(input files) -> payload bytes` uses no network,
clock or environment. The same inputs must give the same bytes, sha256 and CID.

**Content address.**
- `sha256` is the SHA-256 of the payload bytes.
- `cid` is CIDv1 with the raw codec and sha2-256, base32 lower case: `b` +
  base32(`01 55 12 20` ‖ digest).
- The payload must be at most 1 MiB, so it is a single IPFS block
  (`ipfs add --cid-version=1 --raw-leaves`).

**Build report (not part of the payload).** Per source, a whole-file scan must
find no address that the structured parse neither listed nor deliberately
excluded (for example an Israeli wallet whose only order was cancelled). Any
such "unattributed" address means the source format drifted and is reported
for review.

## 4. Checking functions

`asOf` is a UTC calendar date `YYYY-MM-DD`. A malformed date is an error.

| Function | Definition |
|---|---|
| `listingInForce(listing, asOf)` | `valid_until == null` or `valid_until >= asOf` (inclusive). Only Israeli orders carry end dates (orchestrator ruling R4: in-force orders only). |
| `isSanctioned(address, list, asOf)` | The normalized address has at least one listing in force. Invalid input is false. |
| `sanctionListings(address, list)` | Every listing of the address, lapsed ones included (provenance only). |
| `profileSanctionStatus(wallets, list, asOf)` | `blocked` when any normalized wallet is sanctioned; `matched` lists each sanctioned wallet (sorted) with the sorted ids of its in-force sources. An empty set is not blocked. Owner policy C50.1: one listed wallet blocks the whole consolidated profile. |
| `delegationCarriesRights(fromWallets, toWallets, list, asOf)` | False when either side's profile is blocked. Each side is the consolidated wallet set of the delegating or delegate wallet (or the wallet alone). This voids the delegation and never blocks the counterparty (C50.2, ruling R2). |
| `effectiveList(list, corrections)` | Removes the listings named by a signed `6529.sanctions-corrections.v1` file (address, source, entry_id), drops addresses left without listings and recomputes `totals`. |

**Failure rule (ruling R3).** Clients never fail open. If a new release cannot
be verified, keep the last verified one. If none was ever verified, writes
fail closed and an alert is raised.

## 5. Release envelope

```text
{ signed: { _type: "6529.sanctions-list.release", spec_version: "1",
            sequence, published_at, expires_at,          // UTC seconds, ...Z
            payload: { path: "sanctions-list.v1.json", sha256, bytes, cid },
            previous: { sequence, sha256 } | null,
            policy: { id, version } },
  signatures: [ { keyid, method: "eip191-secp256k1", sig } ] }
```

- **What is signed.** Each signature is an EIP-191 `personal_sign` over the
  canonical (RFC 8785) bytes of `signed`. For this method, `keyid` is the
  signer's lower-case Ethereum address.
- **Trust root.** The pinned `6529.sanctions-keys.v1` file names the
  `sanctions` role's keys and threshold: 1 of 1 now, a TUF-style threshold
  later.
- **Verification**, in this order:
  1. At least `threshold` distinct pinned keys recover from valid signatures,
     each matching its `keyid`.
  2. The payload's size, sha256 and CID match.
  3. `sequence` is greater than the last accepted one, which blocks rollback.
- **Expiry.** A release past `expires_at` is still used; it is only reported
  as expired.

## 6. Vectors

| File | Covers |
|---|---|
| `vectors/address-normalization.json` | Normalization and free-text extraction |
| `vectors/canonical-json.json` | RFC 8785 subset, including rejected values |
| `vectors/cid.json` | sha256 and CIDv1 (computed independently) |
| `vectors/check.json` | `isSanctioned`, `profileSanctionStatus`, `delegationCarriesRights`, `effectiveList`, lapsed orders |
| `vectors/builder.json` + `fixtures/` | `fixtures/inputs` (one synthetic file per format) must build to `fixtures/expected/sanctions-list.v1.json` byte for byte |
| `vectors/release.json` | Envelope signing bytes, signature and verification cases (test keys only, derived from a public seed) |

The fixture files are byte-exact (`.gitattributes` disables line-ending
conversion). The fixture addresses are synthetic.

## 7. Running the builder

```bash
6529 run sanctions:list -- run --dir <work dir>          # fetch + build
6529 run sanctions:list -- build --in specs/sanctions-list-v1/fixtures/inputs --out <dir>
```

`fetch` writes `<dir>/<source>/<file>` and `inputs.json` (url, sha256, bytes,
fetched_at; plus the Korean document check). `build` refuses any input whose
bytes no longer match `inputs.json`. It writes `sanctions-list.v1.json` and
`build-report.json`, and diffs against `--previous <payload>` when one is
given.
