# Actual changes: retire Alchemy collection-name search

[BE PR #1974](https://github.com/6529-Collections/6529seize-backend/pull/1974)
removes the Alchemy V3 search implementation and accompanies the address-only
picker in [FE PR #3897](https://github.com/6529-Collections/6529seize-frontend/pull/3897).
Deployment is separate from implementation.

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
