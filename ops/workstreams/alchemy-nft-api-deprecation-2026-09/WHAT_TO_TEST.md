# What to test: backend Alchemy search retirement

Run against an environment containing BE PR #1974. Substitute its API origin
for `<API>`; use the environment's normal authentication/access method.
These are read-only requests. Do not include API keys or credentials in reports.

## Retired search route

- [ ] `GET <API>/alchemy-proxy/collections?query=memes` returns HTTP 410:
  `{"error":"Collection name search is no longer available. Use a contract address."}`.
- [ ] Repeat with no query, a contract address, whitespace, repeated query
  parameters, and an old `pageKey`. Each returns the same 410 response.
- [ ] Response includes `Cache-Control: no-store`. Repeating requests never
  serves an old successful search result through the former Redis cache.
- [ ] If upstream request telemetry is available, verify these requests cause
  no Alchemy search request. There must be no remaining runtime call to
  `searchContractMetadata` from this backend.

## Retained contract-address endpoint

- [ ] `GET <API>/alchemy-proxy/contract?address=0x0C58Ef43fF3032005e472cB5709f8908aCb00205&chain=ethereum`
  returns contract metadata with `_checksum`, not a `contracts` envelope.
- [ ] Repeat with the lowercase address; it resolves the same collection.
- [ ] Missing address, `memes`, and `0x123` return 400 without an Alchemy
  metadata lookup.
- [ ] A provider 404 maps to JSON null; an upstream outage retains a non-success
  error response. Use automated mock coverage or a controlled test environment
  for deterministic provider errors; do not disrupt production.
- [ ] Repeated valid requests retain the existing five-minute metadata cache.
- [ ] Do not expect standalone metadata to certify non-spam status.

## FE integration and unchanged endpoints

- [ ] With FE PR #3897 deployed, block its local contract route in your browser.
  Paste a fresh valid ERC-721 contract address. The BE fallback supplies the
  collection metadata correctly.
- [ ] Block both routes, confirm FE shows an error, remove the blocking rule,
  and use Try again to recover.
- [ ] Smoke-test `/alchemy-proxy/owner-nfts` using a known test wallet/contract.
  Contract filtering and `pageKey` behavior remain unchanged.
- [ ] Smoke-test a known token through `POST /alchemy-proxy/token-metadata`;
  the `tokens` response is unchanged.

## Compatibility and deployment record

- [ ] Record that old FE/Core keyword-search fallback now receives 410.
  This is intentional, not preservation of free-text search.
- [ ] Deploy only service `api` for this implementation. No database migration
  or ingestion/loop Lambda deployment is needed.
- [ ] Confirm FE rollout and the later Core sync/release are tracked before
  September 30, 2026.
- [ ] Keep the external allowlist-service owner audit open until its provider
  usage is verified.

See [Actual changes](ACTUAL_CHANGES.md) for the precise behavior differences.
