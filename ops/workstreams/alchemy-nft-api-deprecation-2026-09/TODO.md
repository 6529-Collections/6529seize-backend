# Alchemy NFT API deprecation TODO

Status: Open

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

## Audit result

| Deprecated endpoint family | Repository status | Assessment |
| --- | --- | --- |
| `getCollectionsForOwner` | Not used | No change. |
| `getCollectionMetadata` | Not used | No change. V3 `getContractMetadata` is already used. |
| `isHolderOfCollection` / `isHolderOfContract` | Not used | No change. V3 `getNFTsForOwner` already receives `contractAddresses`. |
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

## Required TODOs

### 1. Agree the cross-repository replacement contract

- [ ] Choose one behavior with FE before changing the backend route:
  - **Recommended minimal migration:** retire
    `/alchemy-proxy/collections`; require a valid contract address and reuse
    `/alchemy-proxy/contract`, which already calls V3 `getContractMetadata`.
  - **Preserve keyword discovery:** implement a separately selected search
    provider or a 6529-owned indexed catalogue. Do not pass arbitrary text to
    `getContractMetadata`; `contractAddress` is required.
- [ ] Decide whether the old `/collections` route is removed, returns a clear
  terminal migration error for a bounded compatibility period, or is replaced
  by a new explicitly documented search contract.
- [ ] Identify any consumers other than the in-repository FE/Core failover
  client before retiring the runtime-only route.

### 2. Remove the deprecated implementation

- [ ] Remove `AlchemyNftClient.searchContractMetadata` from
  `src/alchemy-sdk.ts` once its final caller is gone.
- [ ] Remove or replace `GET /alchemy-proxy/collections` in
  `src/api-serverless/src/alchemy-proxy/alchemy-proxy.routes.ts`.
- [ ] Remove the `searchContractMetadata` unit case from
  `src/alchemy-sdk.test.ts` and add focused coverage for the chosen replacement
  route or retirement behavior.
- [ ] Update `docs/alchemy-sdk-removal.md`, which currently lists
  `searchContractMetadata` as part of the supported in-tree wrapper surface.
- [ ] Keep `/alchemy-proxy/contract` on V3 `getContractMetadata`; its address
  validation, checksum normalization, cache, 404-to-null behavior, and
  `_checksum` response field remain relevant.

### 3. Correct the first-party response contract

- [ ] Fix or eliminate the current shape mismatch during migration. The
  in-tree Alchemy wrapper unwraps `{ contracts: [...] }` to an array, and the
  backend proxy returns that array. FE/Core's fallback parser expects an
  `AlchemySearchResponse` envelope and reads `.contracts`, so a successful
  fallback response can become an empty result.
- [ ] If keyword discovery remains, define one canonical result envelope,
  pagination contract, spam semantics, and error status across the primary
  frontend route and backend failover route.
- [ ] If a replacement becomes a supported 6529 public API rather than a
  runtime-only proxy, add it to `src/api-serverless/openapi.yaml`, regenerate
  backend artifacts, and synchronize/regenerate the frontend OpenAPI client as
  required by repository policy.

### 4. Validate and deploy before September 30

- [ ] Add route tests for invalid input, a valid address or search query,
  upstream errors, response shape, cache behavior, and the selected
  compatibility behavior.
- [ ] Run focused wrapper/API tests plus the backend lint/build checks required
  by the implementation diff.
- [ ] Re-scan production source for every endpoint name in Alchemy's notice.
- [ ] Deploy service `api` for the proxy change. No database migration or loop
  deployment is expected for the minimal address-only migration.
- [ ] Lambdas requiring redeployment: none; deployment order: N/A. The affected
  proxy is deployed through service `api`, not a separately deployed Lambda.
- [ ] Coordinate deployment ordering with FE: the backend route needed by the
  new frontend must exist first; obsolete route removal must not precede a
  still-live frontend/Core caller unless the release is atomic.
- [ ] Confirm Core receives the matching FE behavior through its renderer sync.

## External dependency follow-up

- [ ] Ask the owner of the separately deployed allowlist service behind FE's
  `ALLOWLIST_API_ENDPOINT` to audit
  `POST /other/search-contract-metadata` and
  `GET /other/contract-metadata/{contract}`. Their implementation is not in
  this backend repository, so its Alchemy usage cannot be proven here.

## Exactness and logic assessment

- `getContractMetadata` is already an exact endpoint-level match for address
  lookup. It receives `contractAddress`; its returned metadata is forwarded to
  FE/Core, whose normalizer handles the OpenSea metadata fields it consumes.
- `getNFTsForOwner` is already an exact endpoint-level match for the former
  holder check use case because the proxy passes `contractAddresses: [contract]`
  and preserves `pageKey`.
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
