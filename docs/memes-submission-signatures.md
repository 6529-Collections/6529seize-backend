# The Memes submission signatures

`POST /drops` accepts an EIP-712 signature for a new `PARTICIPATORY` submission
to the configured Main Stage wave. This authorization says **Submit a Meme Card
to The Memes**. It cannot authorize updating an existing drop. Resubmission
creates a new drop; deleting the previous submission is a separate action.

## Request and signing contract

1. Read the wave ID from `seize-settings.memes_wave_id` and load that wave's
   current name and participation terms. Nonempty terms are required.
2. Show the exact terms and obtain the user's agreement before signing. Bind
   that acknowledgement to the same terms string and wave ID used to sign.
   If either changes, require the user to review and accept again.
3. Build the outgoing drop request, including `signer_address`. Trim the artwork
   title before constructing both the request and signed data. Keep the exact
   request unchanged after signing, including media and metadata.
4. Build the fixed typed-data envelope below and sign it with
   `eth_signTypedData_v4`. Do not personal-sign its JSON or digest.
5. Send the resulting signature as `signature`, and `JSON.stringify(envelope)`
   as `signature_message`, in the same `POST /drops` request.

The envelope has exactly `domain`, `types`, `primaryType`, and `message`.
Domain is `{ "name": "The Memes", "version": "1", "chainId": 1 }`.
There is no `verifyingContract`. Primary type is `MemeCardSubmission`.
Types include `EIP712Domain`, with ordered fields `name: string`,
`version: string`, and `chainId: uint256`.

`MemeCardSubmission` fields are ordered as follows. Names, types, and fixed
statements are protocol values and must not be translated or changed.

| Field        | Type                   | Value                                                                     |
| ------------ | ---------------------- | ------------------------------------------------------------------------- |
| Action       | string                 | `Submit a Meme Card to The Memes`                                         |
| Artwork      | string                 | Exact normalized `drop.title`                                             |
| Destination  | string                 | Current authoritative wave name                                           |
| Agreement    | string                 | `I agree to The Memes submission terms I reviewed.`                       |
| Notice       | string                 | `Submission only. No mint, token approval or asset transfer. No gas fee.` |
| ExpiresAt    | string                 | Canonical UTC ISO timestamp                                               |
| Verification | SubmissionVerification | Fields below                                                              |

`SubmissionVerification` fields are ordered as follows:

| Field       | Type    | Value                                                              |
| ----------- | ------- | ------------------------------------------------------------------ |
| Wallet      | address | Signing wallet matching `drop.signer_address`                      |
| WaveId      | string  | Configured Main Stage ID matching `drop.wave_id`                   |
| Audience    | string  | Lowercase host of the destination API endpoint                     |
| Origin      | string  | Canonical HTTP or HTTPS client origin, with no path or credentials |
| IssuedAt    | string  | Canonical UTC ISO timestamp                                        |
| Nonce       | string  | Fresh lowercase UUID v4                                            |
| PayloadHash | bytes32 | `0x` plus the canonical drop payload SHA256                        |
| TermsHash   | bytes32 | `0x` plus SHA256 of the exact current terms as UTF-8               |

For `PayloadHash`, copy the original outgoing request, remove only `signature`
and `signature_message`, and add `terms_of_service` containing the exact current
terms. Serialize with recursively sorted object keys, preserved array order,
omitted undefined properties and no whitespace; hash the UTF-8 bytes with SHA256.
Other optional request fields affect the hash when present.

Use `Date.toISOString()` timestamps and a five-minute lifetime. The server rejects
expired signatures, a lifetime longer than five minutes, an expiration no later
than issuance, and issuance more than five minutes in the future. Successful
signature verification consumes the nonce atomically; retries need a new
signature. Production fails closed when replay protection is unavailable.

The API compares the signed audience with its validated request Host, never
`X-Forwarded-Host`. Origin records client context and permits canonical native
WebView or external-client HTTP(S) origins. Native clients with an opaque or
custom-scheme origin use their configured web origin. Signing wallets must
belong to the acting author's identity. EOA recovery and EIP-1271 use the exact
EIP-712 digest; the Safe hint is not an authorization decision.

Existing version-2 text signatures remain supported for deployed clients and
other flows. The typed envelope is request-only and is not stored as a durable
signed receipt.

The [fixed test vector](../src/api-serverless/src/wallet-signatures/fixtures/memes-submission-v1.json)
contains a complete request, terms, envelope, EIP-712 digest and public test-wallet
signature. The [verifier](../src/api-serverless/src/wallet-signatures/memes-submission-signature.ts)
is the implementation source of truth.
