# Profile Native CMS Backend Workstream

Mission: implement the backend CMS package service for profile-native CMS.

Scope in this lane:

- Store CMS V1 packages and publication state.
- Expose minimal save, validate, publish, list, primary, by-id, by-version, and by-hash API endpoints.
- Keep CMS V1 schema, hashing, and canonicalization compatible with the frontend protocol contract.
- Prepare storage receipt fields for IPFS, Arweave, and later S3 acceleration work.

Out of scope:

- Builder UX.
- NFT gallery generation.
- Storage upload or pinning orchestration.
- Any CMS schema change not requested through the protocol owner.
