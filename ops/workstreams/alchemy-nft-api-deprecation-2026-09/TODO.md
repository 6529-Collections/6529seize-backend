# Alchemy NFT API deprecation TODO

See [main versus revised: backend acceptance comparison](ACTUAL_CHANGES.md#main-versus-revised-backend-acceptance-comparison)
for current behavior, revised expectations, and the paired frontend feature-removal comparison.

Status: Address-only implementation complete; deployment and manual acceptance pending

Deadline: September 30, 2026

Audit basis: `main` at `35a3ddde898887d003171cc45fa4c3fff0a5e518`

Alchemy will stop serving ten deprecated NFT API endpoint families on the
deadline above. This repository uses one of them: V3
`searchContractMetadata`. The supported `getContractMetadata` replacement is
address-based and is not equivalent to the current keyword-search proxy.

Sources:

- [Alchemy deprecation notice](https://www.alchemy.com/docs/changelog/2026/8/18)
- [V3 `getContractMetadata`](https://www.alchemy.com/docs/reference/nft-api-endpoints/nft-api-endpoints/nft-metadata-endpoints/get-contract-metadata-v-3)
- [V3 `getNFTsForOwner`](https://www.alchemy.com/docs/reference/nft-api-endpoints/nft-api-endpoints/nft-ownership-endpoints/get-nf-ts-for-owner-v-3)
- [Current NFT API endpoint inventory](https://www.alchemy.com/docs/reference/nft-api-endpoints)

## Original audit result (before implementation)

| Deprecated endpoint family | Repository status | Assessment |
| --- | --- | --- |
| `getCollectionsForOwner` | Not used | No change. |
| `getCollectionMetadata` | Not used | No change. V3 `getContractMetadata` is already used. |
| `isHolderOfCollection` / `isHolderOfContract` | Not used | No endpoint migration. V3 `getNFTsForOwner` is already called, but live acceptance later found and corrected its contract-filter serialization. |
| `getSpamContracts` | Not used | No change. |
| `searchContractMetadata` | **Used** | Must be removed or replaced before the deadline. |
| `summarizeNftAttributes` / `summarizeNFTAttributes` | Not used | No change. |
| `computeRarity` | Not used | No change. NextGen rarity fields and calculations are internal application data, not calls to Alchemy's endpoint. |
| `invalidateContract` | Not used | No change. |
| `isAirdrop` / `isAirdropNFT` | Not used | No change. Internal airdrop classification and distribution logic are unrelated. |
| `getNFTSales` | Not used | No change. Internal sales/volume processing does not call this Alchemy endpoint. |

The affected backend path is:

1. `src/api-serverless/src/alchemy-proxy/alchemy-proxy.routes.ts` exposes
   `GET /alchemy-proxy/collections?query=...` and calls
   `alchemy.nft.searchContractMetadata(query)`.
2. `src/alchemy-sdk.ts` implements that wrapper by calling V3
   `/searchContractMetadata` and unwrapping Alchemy's response envelope.
3. The frontend uses this route as failover for its local free-text collection
   search. Core contains the same client path through its imported renderer.

## Implementation checklist

- [x] Remove the sole caller and wrapper method for Alchemy collection search.
- [x] Keep the legacy search route as a non-cacheable HTTP 410 retirement response.
- [x] Retain the contract-address endpoint and its existing response/cache semantics.
- [x] Eliminate the search array/envelope mismatch by removing FE search failover.
- [x] Cover retirement, invalid input, metadata, provider errors, and the retained wrapper.
- [x] Correct `getNFTsForOwner` filtering to emit Alchemy's required
  `contractAddresses[]` query parameter.
- [x] Update the architecture and wrapper documentation.
- [x] Add [Actual changes](ACTUAL_CHANGES.md) and [What to test](WHAT_TO_TEST.md).
- [ ] Complete manual acceptance on the deployed environment.
- [ ] Deploy service `api`; no migration or ingestion/loop Lambda deployment.
- [ ] Coordinate FE rollout and subsequent Core sync/release before September 30.
- [ ] Obtain the external allowlist-service owner's audit of
  `POST /other/search-contract-metadata` and `GET /other/contract-metadata/{contract}`.
  That service source is outside these repositories.

No new public API or schema is introduced, so OpenAPI regeneration is not needed.
The implementation retires a legacy route and preserves its existing error shape.

## Original exactness and logic assessment

- `getContractMetadata` is already an exact endpoint-level match for address
  lookup. It receives `contractAddress`; its returned metadata is forwarded to
  FE/Core, whose normalizer handles the OpenSea metadata fields it consumes.
- `getNFTsForOwner` is the correct endpoint-level match for the former holder
  check use case. The proxy already passed `contractAddresses: [contract]`, but
  its custom REST serializer omitted Alchemy's required `[]` suffix, so the
  provider ignored the filter. This implementation corrects the emitted
  parameter while preserving `pageKey`.
- `searchContractMetadata` is **not an exact behavior-level match** for
  `getContractMetadata`. The former accepts a keyword and returns many
  contracts; the latter accepts one address and returns one contract. The
  migration therefore requires a client/product contract change or a new
  discovery data source.
- No code evidence requires work for the other nine deprecated endpoint
  families. Similar words such as airdrop, rarity, sales, spam, or the local
  `getNFTsForContract` helper are not calls to Alchemy's removed APIs.
- This future implementation changes an external integration boundary, so its
  PR should update `docs/architecture.md` if the chosen solution materially
  rewires the provider or API shape. The TODO-only PR does not change system
  architecture.
