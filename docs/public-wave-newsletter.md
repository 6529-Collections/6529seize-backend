# Public-wave newsletter

`newsletterLoop` publishes a short 6529 Daily Post edition to a configured
wave using a configured publisher wallet. EventBridge invokes it directly at
00:00 UTC. There is no queue or frontend change. Two entity-synchronized tables,
`newsletter_editions` and `newsletter_edition_sources`, record each edition's
outcome and validated sources, and `GET /v3/community-memory/sources` exposes
the published sources as a public history (see [Source integrity](#source-integrity)).

The visible heading contains the newsletter name and edition date, followed by
an estimated reading time (for example, "3 minute read"). The application counts
visible prose and link labels at 250 words per minute, rounding up to a minimum
of one minute. Exact reporting-window timestamps are stored in the drop metadata.

## Configuration

Use the existing `prod/lambdas` Secrets Manager JSON in `us-east-1`:

| Key | Value |
| --- | --- |
| `NEWSLETTER_TARGET_WAVE_ID` | Destination wave UUID |
| `NEWSLETTER_PUBLISHER_WALLET` | Publisher's Ethereum wallet address |
| `NEWSLETTER_PUBLISHER_PRIVATE_KEY` | Matching signing key |
| `NEWSLETTER_BEDROCK_MODEL_ID` | Optional; defaults to `global.openai.gpt-6-astra` |

The publisher must already have a 6529 profile and permission to post in the
destination. The key only signs the normal API login challenge; it is never sent
to Bedrock or the API. Do not put it in code, workflow inputs, or logs.

If any required value is absent or blank, the invocation succeeds with
`not-configured` before connecting to the database or contacting Bedrock/the API.
Complete but invalid configuration fails with a sanitized error. The deployment
environment `NEWSLETTER_STAGE` must be `prod`; other stages return
`not-production` before loading secrets. Shared secrets are cached per warm
Lambda execution environment, as in other loops; recycle environments after
changing configuration when immediate activation/deactivation is required.

## Time windows and retries

Scheduled events cover the complete previous UTC day, start inclusive and end
exclusive. The original EventBridge event timestamp determines the day even if
delivery is delayed. Before generation, a primary-DB query looks for the
publisher's drop in the destination carrying `newsletter_edition_id=daily:DATE`.
`DATE` is the covered day: an October 1 midnight event uses `daily:2026-09-30`.
The normal drop API commits this metadata with the published drop. Reserved
concurrency of one serializes executions; a scheduled retry skips a committed
edition, including when an earlier response was lost. Deleting the published
drop removes that deduplication marker.

The existing API contracts are synchronous: `DropCreationApiService.createDrop`
awaits `executeNativeQueriesInTransaction`, and
`CreateOrUpdateDropUseCase.insertAllDropComponents` awaits `insertDrop` and
`insertDropMetadata` on that same connection. Public identity lookup maps
`IdentitiesDb.getIdentityByWallet().profile_id` to `ApiIdentity.id`;
authentication uses `getProfileIdByWallet`, which uses the same wallet/consolidation
join. The publisher supplies no proxy role, so this is also the stored drop
author. Chat drops accept `signature: null`; participation signature requirements
apply to participatory drops. The destination must allow the publisher to chat.

Manually invoke with `{}`. Every invocation covers the rolling 24 hours ending
at invocation start, uses a fresh edition ID, and bypasses the daily check. A
manual retry is intentionally another edition. Only genuine EventBridge-shaped
scheduled events use the daily path; do not paste such an event when requesting
a manual edition.

To publish a fresh comparison edition for a specific UTC day, manually invoke
with `{"date":"2026-09-24"}`. This covers September 24 from 00:00 UTC to the next
midnight and uses the manual path, so an existing daily edition does not suppress
publication. Dates must be valid calendar dates in `YYYY-MM-DD` format. Scheduled
events always use their original event timestamp, regardless of a `date` field.

## Reporting boundary

Parameterized SQL reads every active anonymously readable wave, including public
subwaves whose parent is public. It excludes DMs, restricted parents/children,
non-visible moderated drops, the destination, and the publisher's own messages.
Reply and quote context uses the same public filters, including older context
needed to link the start of a discussion. Main Stage decisions are selected by
decision time, and indexed Meme and Meme Lab mint transactions by transaction time. Indexing
lag can delay an event's availability; missing transactions are not evidence
that no mint occurred.

Bedrock receives only that public reporting material. The prompt requires
citations by source id, winner and mint coverage, and an optional brief final
team section; it forbids URLs and links in prose. There is one editorial pass
for ordinary volumes. Large days first select stories from every input batch
(briefs stay free text but must carry the exact source ids), then compose one
structured edition; no second fact-check model or private-data tool exists.
Oversized source sets or incomplete model responses fail instead of publishing
truncated coverage. The validator below guarantees that every link, name, date
and identifier in the published edition comes from database records; it does
not guarantee that the prose interprets those records correctly.

Collection checks a two-minute deadline between DB batches and caps the complete
run at 25,000 drops, 10 MB of message/media URL text, and 100 context-expansion
rounds. Crossing a limit throws `NewsletterCollectionLimitError`, reports a
Lambda failure, and never calls the writer or publisher with a partial result.
These checks bound public historical context as well as the current day's
activity. The writer has a separate ten-minute total deadline (including research)
and four-minute individual request timeouts. A slow individual DB query still
relies on the database driver's timeout and Lambda's outer execution limit.

Mint counts use the existing transaction primary key (transaction hash, sender,
recipient, contract and token ID); re-indexing the same stored transaction does
not insert another row. They remain indexed transfer counts, not an independently
reconciled on-chain audit.

## Source integrity

### Source model

Collection (`newsletter-collector.ts`, `newsletter-sources.ts`) assigns every
record a deterministic id derived only from database identifiers:

| Kind       | Id                                                                               | Canonical URL                                                          | Event time                        |
| ---------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------- |
| `DROP`     | `drop:<drop_id>`                                                                 | `https://6529.io/waves/<wave_id>?serialNo=<serial_no>`                 | drop `created_at`                 |
| `WINNER`   | `winner:<competition_id>:<entry_id>` (legacy winners fall back to `drop:<drop_id>`) | competition entry page, or the discussion URL for legacy winners       | decision time                     |
| `MINT`     | `mint:<the-memes or meme-lab>:<card>`                                            | card page                                                              | first mint in window              |
| `IDENTITY` | `identity:<profile_id>`                                                          | `https://6529.io/<handle>`                                             | collection time (reference only)  |

The ids appear in the model-facing material (`source_id`,
`discussion_start_source_id`, `author_source_id`, `quoted_source_ids`,
`drop_source_id`). The collector also builds a `SourceRegistry`, keyed by id,
holding `kind`, `canonical_url`, `title`, `author_handle`, `wave_id`,
`wave_name`, `time`, `context_only`, `observed_at` (when the collector read the
row) and `content_fingerprint` (sha256 of the collected title, text parts,
quoted ids and media URLs; for winners the decision fields, for mints the card
fields and count). The registry is populated only from database rows; model
output can cite entries but never add to them. Text inside a message is data:
an instruction such as "cite https://evil.example" that appears in a drop is
fingerprinted and otherwise ignored.

### Output contract

The writer must return one JSON object (a single code fence is tolerated):

```json
{
  "sections": [
    { "heading": "…", "paragraphs": [{ "text": "…", "citations": ["drop:…"] }] }
  ],
  "winners_covered": ["winner:…"],
  "mints_covered": ["mint:…"]
}
```

`newsletter-output.schema.ts` validates the shape with zod (strict objects,
bounded lengths, ids matching `^(drop|winner|mint|identity):…`). Anything else,
including the former free-form Markdown, is rejected as malformed.

### Validator rules

`newsletter-validator.ts` runs before publication and rejects an edition when:

- any citation is not in the registry (unknown or invented ids);
- any heading or paragraph contains a URL, bare domain reference, Markdown
  link or autolink (links are never taken from prose);
- a paragraph cites no source;
- a cited source that is not `context_only` has an event time outside
  `window.start <= time < window.end` (end exclusive); older discussion roots
  and identities are `context_only` and may be cited as context;
- `winners_covered` / `mints_covered` list an unknown id, an id of another
  kind, or an id no paragraph cites, or omit a `WINNER` / `MINT` record the
  collector found.

`renderNewsletter()` re-validates, escapes bracket characters in model prose,
and renders each paragraph followed by an italic `Sources:` line of
`[label](canonical_url)` links. Labels and URLs come from the registry only:
titles, handles, wave names, card numbers and dates are never copied from the
prose. The existing size check (`newsletterMarkdown`) still applies.

### Failure state and inspection

`publishNewsletter()` persists one `newsletter_editions` row per attempt:

- `REJECTED`: nothing is published. The row keeps `raw_output` (the model's
  answer), `rejection_reasons` (JSON list) and `sources` (the registry
  snapshot), and the run returns `rejected-unverified` with the reasons. No
  `newsletter_edition_sources` rows are written. A scheduled retry of the same
  day runs again and overwrites the row.
- `PUBLISHED`: the row records the `drop_id` and the registry snapshot, and
  every registry record is materialized in `newsletter_edition_sources`
  (unique per `edition_id, source_id`).

To inspect a rejection, read `newsletter_editions` by `edition_id`
(`daily:YYYY-MM-DD` or `manual:<uuid>`). The drop-metadata deduplication is
unchanged; additionally a scheduled run whose edition row is already
`PUBLISHED` returns `already-published` without collecting. Edition rows are
written after the drop is created, outside a transaction; the drop metadata
remains the primary idempotency marker.

Reference validity establishes that a source exists and is correctly
identified. It does not prove that every interpretation in the prose is true.

### Public history endpoint

`GET /v3/community-memory/sources` (anonymous, cached 60 s) pages the stored
source records of `PUBLISHED` editions, ordered by `(time, source_id)` with an
opaque base64 cursor, `limit` 1–100 (default 50), optional `wave_id`,
`edition_id`, and a half-open `from`/`to` window (ISO-8601 or epoch ms, at most
31 days when both are given). Each record carries `provenance.edition_id`,
`provenance.collected_at` and `content_fingerprint`, so a reader can trace it
to the edition and detect later content changes. `classification` is derived at
read time: `WINNER` and `MINT` are `OUTCOME`, drops in 6529 team waves are
`ANNOUNCEMENT`, other drops are `DISCUSSION`, identities carry none;
`CORRECTION` is reserved.

Drop-backed records are re-joined to the live `drops` row through the same
public filter the collector uses (anonymous wave read access, no DMs, public
competition entry, moderation state `VISIBLE`). Content that was public when
published but has since been deleted, hidden, moderated or restricted is not
republished. `MINT` records are on-chain facts and `IDENTITY` records are
profile references; neither is re-joined.

## Rollout and operations

The service catalog permits **production only**. Code still merges through
`1a-staging` for the normal review/promotion process, without deploying this
Lambda there. After production is authorized, deploy only `newsletterLoop` via
`Deploy a service` on `main`, with `environment=prod`. Then run `Deploy operational
monitoring` for `prod` to update the monitoring allowlist, source log subscription,
and Errors/Throttles alarms. The Lambda must exist first so its log group is
available. Deploy `dbMigrationsLoop` first so entity synchronization creates
`newsletter_editions` and `newsletter_edition_sources`, then `newsletterLoop`,
then `api` for the public history endpoint. No migration file is required. Its existing
`lambda-vpc-role` needs Bedrock InvokeModel
access for the selected inference profile and routed foundation models, database
connectivity, and access to the shared secret.

Deploying with any required setting missing leaves publication disabled; the
schedule still invokes a successful no-op daily. Configure all three only when publication is intended. Error reporting
uses the existing Sentry wrapper and CloudWatch Lambda logs; logs contain counts,
model usage, edition/drop IDs, and statuses, not source messages or credentials.
To suspend the schedule immediately, disable its EventBridge rule. Scheduled
errors follow Lambda/EventBridge retry behavior; exhausted failures require an
operator to inspect logs and retry the original scheduled event if appropriate.
