# Actual changes: retire Alchemy collection-name search

[BE PR #1974](https://github.com/6529-Collections/6529seize-backend/pull/1974)
removes the Alchemy V3 search implementation and accompanies the address-only
picker in [FE PR #3897](https://github.com/6529-Collections/6529seize-frontend/pull/3897).
Deployment is separate from implementation.

## Main versus revised: backend acceptance comparison

Baseline checked on September 9, 2026: BE `main` at
`41dfb41a33b9c1c01b7f4cb6a082838febf4594e`. This is a source comparison,
not an assertion about which version is deployed in any environment.

| What to test / feature | Main at the baseline above | Revised BE #1974 |
| --- | --- | --- |
| Nonempty `/alchemy-proxy/collections?query=memes` | Calls Alchemy `searchContractMetadata` and returns a contract array on success. | Always 410 with `Collection name search is no longer available. Use a contract address.` No search call or results. |
| Empty or missing query | 400 with `query is required`. | Same 410 retirement message as nonempty queries; retirement takes precedence over input validation. |
| Search caching | One-minute request cache may serve successful search results. | No search-cache middleware; `Cache-Control: no-store`. Old search entries are not read. |
| Older-client keyword fallback | BE is the fallback for FE/Core collection-name search. The array/envelope mismatch can already hide successful results. | No keyword fallback remains. Older clients receive 410 and may show no suggestions; apply the release gate below. |
| `/alchemy-proxy/contract` and FE address fallback | Existing V3 contract metadata with `_checksum`, input validation, error handling, and five-minute cache. | Unchanged. Verify valid/mixed-case addresses, invalid input, and FE failover using the existing contract endpoint. |
| Owner NFTs and token metadata | Existing owner filtering/pagination and token metadata. | Unchanged. Smoke-test known wallet/contract and token inputs. |
| Deployment units | Existing API Lambda and ingestion/loop services. | Redeploy `api` only after FE rollout and the compatibility gate. No migration or other Lambda dependency. |

The sole externally visible BE feature removal is collection-name search
through `/alchemy-proxy/collections`; its unused SDK wrapper is also removed.
The address-only picker, removal of keyword suggestions and **Show anyway**,
and preserved token/card search behavior are frontend-owned. See the paired
[full FE main-versus-revised comparison](https://github.com/6529-Collections/6529seize-frontend/blob/agent-prxt/alchemy-nft-api-deprecation-todo/ops/workstreams/alchemy-nft-api-deprecation-2026-09/ACTUAL_CHANGES.md#what-to-test-main-versus-revised)
and [features removed](https://github.com/6529-Collections/6529seize-frontend/blob/agent-prxt/alchemy-nft-api-deprecation-todo/ops/workstreams/alchemy-nft-api-deprecation-2026-09/ACTUAL_CHANGES.md#features-removed-main-versus-revised).

## Behavior and API differences

| Capability | Before | After |
| --- | --- | --- |
| `GET /alchemy-proxy/collections` | Accepted free-text `query` and called Alchemy's retiring `searchContractMetadata`. | HTTP 410 with `{"error":"Collection name search is no longer available. Use a contract address."}`. Applies to all query values, including addresses and missing query. |
| Search response | A bare contract array after the wrapper unwrapped Alchemy's envelope. FE/Core expected an envelope, which could silently produce no suggestions. | No search results. FE removes that fallback and parser rather than maintaining a redundant search response shape. |
| Search caching | One-minute request cache could serve search data. | No search cache middleware; `Cache-Control: no-store`. Old Redis search entries are no longer read by this route. |
| In-tree Alchemy wrapper | Exposed `searchContractMetadata(query)`. | Method and its obsolete unit case are removed. No other wrapper method changes. |
| Keyword discovery, ranking, pagination, spam-filtered result lists | Depended on Alchemy's search behavior. | Not replaced. `getContractMetadata` cannot provide these features. |

## Retained contract

`GET /alchemy-proxy/contract?address=<address>&chain=ethereum` still uses V3
`getContractMetadata`. Valid requests return the existing metadata object plus
`_checksum`, without a `contracts` search envelope. Invalid input returns
400; an upstream 404 returns JSON null; other upstream errors retain the
existing 400 error behavior. The five-minute metadata cache is unchanged.

No new public endpoint, generated model, OpenAPI schema, database migration,
or provider is introduced. The retired route keeps the existing legacy error
shape. Owner NFT filtering/pagination and token metadata remain unchanged.

No spam lookup is added: standalone contract metadata is not an affirmative
spam verdict. FE retains its previous pasted-address behavior, which did not
apply the keyword result filter.

## Compatibility and release requirements

- Old FE/Core versions using collection-name fallback will receive 410 and
  may display no suggestions. Deploying this BE change alone does not teach
  those clients address-only UX.
- Deploy updated FE first using the already-existing contract endpoint. Gate BE
  retirement on older web/desktop clients being updated, or explicit release
  owner acceptance of compatibility loss for remaining older clients. Record
  that decision and the Core release plan before deploying BE; there is no
  server-only way to preserve keyword discovery after the provider deadline.
- Core's own renderer search and the separately deployed allowlist service
  remain outside this implementation. Their retirement work is still required.
- Deployment unit: `api` only. No ingestion or loop Lambda requires deployment:
  only the API called the removed wrapper method, and all retained shared
  wrapper behavior is unchanged. No migration or service dependency order.
- A rollback after September 30, 2026 must not restore calls to the removed
  Alchemy endpoint; use a corrective address-only release.

See [What to test](WHAT_TO_TEST.md) and [remaining TODOs](TODO.md).
