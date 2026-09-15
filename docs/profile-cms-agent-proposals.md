# External agents and CMS proposals

A profile owner can give an external agent temporary access to one saved CMS
draft. The agent can read the complete website and propose a complete replacement
package for review. It cannot save a draft, upload media, publish, unpublish,
roll back, archive, or change the profile. The owner uses the ordinary editor and
wallet publication flow. No model provider key or paid inference service is
required by this API.

File exchange remains available without a connection. This API is the transport
foundation for a local stdio MCP adapter; it does not provide a hosted OAuth or
remote MCP server.

## Owner consent and credentials

Save the intended base first. Create access with
`POST /profile-cms/packages/{id}/agent-grants`, sending a label, the expected
package hash, and optionally `expires_in_seconds`. The default duration is one
hour; permitted durations are 60 seconds through 24 hours. Only a current owner
wallet can create or manage access; a proxy session cannot do so.

The response shows an opaque token once. Store it as a secret and send it only
in the `Authorization: Bearer` header of the `agent-session` endpoints. Do not
share a website JWT, refresh token, wallet key, or model provider key. The API
stores a digest of the random token, never the token itself.

Consent must disclose that the external agent can read the selected draft's
entire package, including its source packets. Draft visibility is independent
of publication. Treat external source content and agent proposals as untrusted
content to review.

Access is pinned to the saved row, profile, logical package ID, version, and
hash. Saving another revision does not advance it. To use a changed base, issue
new access explicitly. Current owner wallet membership, draft status, expiry,
revocation, and the base are checked using the database writer on every agent
request. Revocation takes effect for requests authorized after it commits.

Use `GET /profile-cms/packages/{id}/agent-grants` to inspect access and
`DELETE /profile-cms/agent-grants/{id}` to revoke it. Revocation and owner review
remain available while new agent work is disabled.

## Agent operations

| Operation | Endpoint | Result |
| --- | --- | --- |
| Read the selected draft | `GET /profile-cms/agent-session/draft` | Complete V1 package, grant details and candidate constraints |
| Validate a proposal | `POST /profile-cms/agent-session/proposals/validate` | Normalized candidate, recomputed hashes and validation diagnostics |
| Submit a proposal | `POST /profile-cms/agent-session/proposals` | Immutable proposal awaiting owner review |
| Read a submitted proposal | `GET /profile-cms/agent-session/proposals/{id}` | Full proposal and its recorded review state |

Validation and submission take the base draft ID, version and hash alongside
`candidate_package`. Submission also requires a UUID `idempotency_key` and a
summary of at most 1,000 characters. Repeating the same key with the same body
returns the original proposal. A different body with that key returns a conflict.

The candidate is a complete V1 website, so every page, navigation entry, layout,
and authored text can be reviewed. Profile identity, logical package ID,
`site.base_path`, and the entire saved asset catalog must remain unchanged.
Choose from existing assets; the owner uploads or imports new media and saves
a new base before granting access again. Retaining an asset record does not
claim that this API reverified its remote media bytes. The proposal service
does not fetch URLs.

The server recomputes payload and package hashes. It replaces submitted
signatures and storage receipts with the same explicit draft fixtures used by
ordinary draft saving. A proposal is not a signed publication or storage proof.
The adapter should bundle the compatible V1 JSON schema; the response identifies
the `6529.cms.agent_candidate.v1` proposal contract and its machine-readable
constraints. The existing public agent schema bundle is a descriptor rather
than a hosted complete JSON schema.

## Review and apply

Owner lists at `GET /profile-cms/packages/{id}/agent-proposals` contain summaries
only. Fetch the complete candidate using
`GET /profile-cms/agent-proposals/{id}`. These owner endpoints remain usable
after grant expiry or revocation; expired or revoked agents cannot read them.

The editor must compare the proposal with the current document before applying
it locally. Applying locally does not save or publish it. Unrelated or unsaved
owner changes require an explicit conflict decision.

Record a decision with `POST /profile-cms/agent-proposals/{id}`, including the
expected base draft ID, base hash, and candidate hash. `rejected` changes no
website content. To record `applied`, first save the exact reviewed candidate
through the existing owner draft endpoint, then provide the new saved row ID
and hash. The API verifies that the result is a newer draft in the same profile
and logical package, created after the proposal, with the exact candidate hash.
It never performs that save itself. Ordinary draft saving preserves the
candidate core hash while replacing draft signing/storage fixtures.

States are `pending`, `rejected`, and `applied`. Final decisions are immutable;
an identical repeat is idempotent and a conflicting decision fails. `applied`
means saved as the verified draft, not published. Publication still requires
the separate reviewed wallet signature and storage flow.

## Limits and failure behavior

- Requests are limited to 1 MiB of JSON, depth 32 and 50,000 JSON nodes.
- Each grant allows 200 agent requests and 20 proposals.
- Each profile allows five active grants, 20 grant creations per rolling day,
  and 100 proposals per rolling day.
- Owner lists use a default page size of 20 and a maximum of 50. Proposal lists
  do not load or return full candidate packages.
- Quotas, idempotency, proposal writes and audit events use writer transactions.
  Database failure denies work; Redis availability does not bypass these quotas.
- Expected authenticated validation failures consume a request. Malformed or
  oversized HTTP bodies are rejected before candidate processing.
- Private responses use `Cache-Control: private, no-store`. Error handling
  removes draft bodies and credentials before reporting errors.

Grant expiry does not delete proposals or audit history. Proposals remain
available to the current owner for review. The API has no automatic retention
cleanup or owner deletion endpoint in this increment.

Set `FEATURE_PROFILE_CMS_AGENT_PROPOSALS=false` to stop new grant issuance and
agent read/proposal work. Owner access management and review remain available.
The default is enabled; creating an owner-authorized grant is the opt-in action.

Deploy the additive tables through `dbMigrationsLoop`, then deploy `api`
(`seizeAPI`), and then deploy any dependent frontend/adapter. Existing packages,
publication signatures and public primary pointers remain compatible.
