# 6529 Help Bot Runtime

## 1. Objective

Add a 6529 Help Bot, also referred to as the helper chatbot, that can answer
product questions inside Waves. Users can trigger it by mentioning the bot or by
replying directly to a previous bot answer.

The bot should respond quickly with visible status reactions, answer as a reply
to the triggering message, and use a frontend-provided help index to ground
answers.

V1 ships without full RAG. It retrieves bounded product records from the
frontend-published `/help-index.json`, caches the latest valid copy in the
backend answer path, and uses a Bedrock renderer for natural wording with a
deterministic fallback if the model call fails or times out. It also supports a
bounded public-data query mode for aggregate questions that are better answered
from backend database rows than from static frontend docs.

## 2. Product Behavior

### 2.1 Primary trigger

A user posts a wave message that mentions the bot handle, for example:

```text
@6529help what is TDH?
```

Runtime behavior:

1. Detect the bot mention.
2. Add a 👀 reaction to the triggering message immediately.
3. Enqueue an asynchronous help job.
4. Generate an answer from retrieved help context.
5. Post the answer as a reply to the triggering message.
6. Replace the 👀 reaction with ✅ on success.

### 2.2 Follow-up trigger

A user replies directly to a previous 6529 Help Bot message without mentioning
the bot.

Runtime behavior:

1. Detect that the parent message was authored by the bot.
2. Ignore obvious non-questions such as `thanks`, `ok`, or `got it`.
3. Add a 👀 reaction to the follow-up message immediately.
4. Enqueue an asynchronous help job with short thread context.
5. Post the answer as a reply to the follow-up message.
6. Replace the 👀 reaction with ✅ on success.

Only direct replies to bot messages should trigger follow-up behavior. The bot
should not listen to every later message in the wave.

### 2.3 Failure behavior

The bot must fail visibly.

If the bot cannot produce a reliable answer from indexed sources:

1. Replace 👀 with ⚠️.
2. Reply without hallucinating. If the unanswered question appears to be about
   the 6529 product and `HELP_BOT_TECH_TEAM_HANDLES` is configured, append
   those handles as mentions.

```text
I don't have enough knowledge to help you here.
```

If the question is outside the 6529 product scope, such as general history,
news, trivia, or unrelated world knowledge, the bot should not answer the
question and should not tag the tech team:

```text
I can only help with 6529 product questions.
```

If the bot hits a technical issue, timeout, or provider error:

1. Replace 👀 with ⚠️.
2. Reply:

```text
I saw this, but I hit a temporary issue while looking it up. Please try again in a minute.
```

The bot should not hallucinate a fallback answer when source confidence is low.

Obvious impossible requests, privilege requests, prompt-injection attempts, or
private-data pokes should not page the tech team. The bot should answer with a
short bounded refusal, for example:

```text
Nice try. I can't grant TDH, REP, NFTs, admin powers, or secret shortcuts on request. Ask me how the real thing works and I'll point you to the right page.
```

This branch is only for clear messing-around or bypass attempts. Genuine
unsupported product questions should still use the no-reliable-source path
above, including optional tech-team mentions when configured.

The hardcoded `@6529help` handle is resolved to the current profile id at
runtime. Successful resolutions cache for five minutes; missing-profile lookups
cache for 30 seconds so manual profile creation becomes active quickly.

## 3. Non-Goals

- Do not answer without a user trigger.
- Do not process private waves, restricted-visibility waves, or direct-message
  waves.
- Do not inspect GitHub or frontend source files during the live answer path.
- Do not train or fine-tune a model for V1.
- Do not provide private wallet-specific eligibility answers unless a dedicated
  authenticated tool is added.
- Do not let the LLM query arbitrary backend tables or execute unvalidated SQL.
- Do not execute SQL text emitted by the LLM in the public-data path.
- Do not replace human support or moderation.
- Do not merge, deploy to staging, or activate production behavior in this
  PR-ready/no-deploy pass.

## 4. Knowledge Architecture

### 4.1 V1 frontend-owned help index

V1 answers from short frontend-owned records for common 6529 topics, routes, and
UI affordances. The source of truth lives in the frontend repository at
`ops/help/help-index.json`; the frontend build publishes
`public/help-index.json`; the backend reads the deployed artifact at
the environment-matching frontend host: `https://staging.6529.io/help-index.json`
when `NODE_ENV=development`, and `https://6529.io/help-index.json` otherwise.

Initial curated topics include:

- TDH and network definitions
- Waves and wave creation
- subscriptions and subscription eligibility
- profile subscriptions tab
- REP/CIC and Levels
- delegation
- The Memes
- NextGen

The backend does not inspect GitHub, frontend source files, or live rendered
pages while users wait for answers. It fetches the generated index, validates a
usable record set, caches successful loads for five minutes,
and keeps the previous valid cache if a refresh fails. Fetches use
the hardcoded five-second timeout so a slow index endpoint fails into the
technical-failure reply path instead of stalling the worker.

### 4.2 Future docs chunking and RAG

The frontend index can later include generated chunks from frontend `ops/docs`,
route metadata, component help metadata, embeddings, and eval coverage. That
future phase should keep curated records as the higher-confidence source for
canonical facts and URLs.

### 4.3 Backend-owned business-rule records

The frontend owns product navigation and UI knowledge. The backend may add
backend-owned records later for business rules that are not safe to infer from
frontend pages alone. Examples:

- subscription processing behavior
- eligibility concepts where rules are implemented in backend services
- wave and drop permission rules
- rate limit or posting restrictions

Those records should be short, curated records or generated summaries from
backend docs and tests. Raw code lookup should happen offline during indexing or
authoring, not during a user request.

### 4.4 Backend-owned public data query mode

Some questions should be answered from public indexed data, not from the
frontend help index. Examples:

- `how many memes are in szn1`
- `what is the TDH rate of Meme #1`
- `what is the highest TDH rate`
- `what is the highest edition size`
- `what is total TDH`

For V1, Bedrock does not author SQL. Bedrock maps the user's question to a
semantic public-data plan, for example
`{"entity":"meme_cards","operation":"count","metric":null,"filters":{"season":1},"limit":1}`.
The backend rejects unknown entities, operations, metrics, filters, and invalid
numeric values, then compiles the plan to backend-owned parameterized SQL. SQL
from Bedrock is never executed.

Initial public-data plan surface:

- `meme_cards` supports `count`, `value`, `max`, `min`, `sum`, and `avg`.
- `meme_cards` metrics include `tdh_rate`, `edition_size`, and `supply`.
- `meme_cards` filters include numeric `meme` and `season`.
- `tdh_global` supports latest `total_tdh`.

Initial backend public tables:

- `nfts`: Meme Card names, supply, TDH fields, and `hodl_rate` used as card TDH
  rate. Owner, wallet, and identity columns are not exposed through the V1
  catalog.
- `memes_extended_data`: season, meme number/name, edition size, holder, burn,
  and uniqueness metrics.
- `latest_tdh_global_history`: latest global TDH total plus date/block context.

Public-data queries execute through the shared `SqlExecutor` with the read pool
forced, backend-applied hard row limits, and a MySQL `MAX_EXECUTION_TIME` hint
injected by backend code. The mysql pool configuration does not enable
`multipleStatements`; this mode also does not accept statements from the model.

If the public-data planner fails, returns an unknown plan field, or returns
invalid values, the bot declines that data mode and falls back to the normal
help-index path. If a compiled DB query returns no rows or only null aggregate
values, the bot also declines that data mode instead of wording an empty result
as a fact. If a compiled DB query times out or fails, the bot uses the
technical-failure reply path.

Natural wording may lightly mirror the user's tone. Casual questions can receive
slightly warmer wording, and formal questions should stay formal, but tone never
overrides the source facts, refusal boundaries, no-reliable-source behavior, or
technical-failure behavior. Deterministic fallback answers remain neutral.

### 4.5 Agent maintenance contract

Future agents must treat the help bot corpus as part of the user-facing product
surface. When a backend change adds or changes behavior that users may ask
`@6529help` about, update the help bot materials in the same PR.

Backend-owned examples:

- subscription behavior and eligibility concepts
- wave, drop, voting, or permission rules
- posting limits, slow-mode, or rate-limit explanations
- backend-owned product terminology
- canonical URLs for backend-owned reports or tools

For frontend product knowledge, update the frontend-owned
`ops/help/help-index.json` source and generated `public/help-index.json` in the
frontend PR. Backend runtime changes should update focused help bot tests and
this runtime spec when trigger behavior, failure wording, provider behavior,
source ownership, observability, or coverage expectations change.

If a backend change is user-visible but intentionally should not be answerable
by the bot yet, the PR should say why and whether a follow-up corpus update is
needed.

### 4.6 Retrieval model

The bot should not depend on a predefined list of questions. It should retrieve
records and chunks by:

- exact alias lookup
- keyword search
- vector search
- lightweight intent classification where useful

The live answer prompt should receive only the top relevant snippets, not the
entire corpus.

For V1, retrieval is alias/keyword scoring over the cached frontend records plus
Bedrock-planned public-data intents compiled to backend-owned SQL.
Direct follow-up questions first match the current user message; previous bot
answer text is used only as fallback context so old wording does not dominate
the next topic.

## 5. Runtime Flow

### 5.1 Mention flow

```text
message_created
  -> detect @6529help
  -> create interaction row
  -> add 👀 reaction
  -> enqueue help job
  -> worker retrieves context or validated public DB rows
  -> worker calls LLM
  -> worker posts reply
  -> replace 👀 with ✅
```

If a user replies to someone else's question with only `@6529help`, the bot uses
the parent drop text as the question and targets the parent drop for 👀, ⚠️/✅,
and the bot reply. This only applies in public waves. The parent drop is fetched
through the caller's normal visibility checks, and the summoning drop remains the
idempotency trigger.

### 5.2 Follow-up flow

```text
message_created
  -> parent message is from 6529 Help Bot
  -> message is not a trivial acknowledgement
  -> create interaction row
  -> add 👀 reaction
  -> enqueue help job with previous bot answer context
  -> worker retrieves fresh context or validated public DB rows for current question
  -> worker calls LLM
  -> worker posts reply
  -> replace 👀 with ✅
```

If the triggering author has already tripped the per-user spam threshold, the
bot records the interaction, reacts `⛔️` to the triggering drop, does not queue
answer generation, and does not post a reply.

### 5.3 Failure flow

```text
help job fails or source confidence is too low
  -> update interaction status
  -> replace 👀 with ⚠️
  -> post failure reply
```

## 6. State and Idempotency

Add an interaction record to prevent duplicate bot replies.

Recommended fields:

- `id`
- `trigger_drop_id`
- `target_drop_id`
- `wave_id`
- `author_id`
- `parent_bot_drop_id`
- `trigger_type`: `MENTION` or `BOT_REPLY`
- `status`: `SEEN`, `ANSWERING`, `ANSWERED`, `NO_RELIABLE_SOURCE`,
  `SPAM_SUPPRESSED`, `FAILED`
- `bot_reply_drop_id`
- `knowledge_version`
- `failure_reason`
- `created_at`
- `updated_at`
- `answer_started_at`
- `completed_at`

Idempotency rules:

- One interaction per triggering message.
- Replies and reactions target `target_drop_id` when present, otherwise
  `trigger_drop_id` for older rows.
- If an interaction exists in `SEEN` or `ANSWERING`, do not enqueue another job.
- If an interaction is `ANSWERED`, do not answer again unless explicit retry
  behavior is added later.
- Bot-authored messages must not trigger the bot.

## 7. LLM Provider

V1 should use a managed LLM provider rather than self-hosting.

V1 provider:

- Amazon Bedrock with the hardcoded Claude model selected in backend code.

The backend should isolate provider calls behind an internal service boundary so
the model can change later.

Prompt rules:

- Use only provided help context.
- Keep answers short, usually two to five sentences.
- Include canonical links when present.
- Do not invent URLs.
- If context is insufficient, return a no-reliable-source result.
- Preserve conversational tone without pretending to be human.

The LLM is responsible for natural wording only. It is not responsible for
deciding canonical facts or links without retrieved context. If Bedrock fails
or times out after a reliable record is found, V1 uses the deterministic record
answer.

## 8. Answer Examples

### 8.1 TDH

User:

```text
@6529help what is TDH?
```

Bot:

```text
TDH stands for Total Days Held. It is a time-weighted NFT holding metric that uses days held, edition-size weighting, and active boosters. More info: https://6529.io/network/tdh
```

### 8.2 Wave creation

User:

```text
gm 🙂 Do we have any docs how to create a wave the features etc?
```

Bot:

```text
gm 🙂 Yes. To create a wave, click the + button at the top-right of the Waves panel, or open https://6529.io/waves/create. The flow supports Chat, Rank, and Approve waves, with settings for access groups, dates, drops, voting, outcomes, and description depending on the type.
```

### 8.3 No reliable source

Bot:

```text
I don't have enough knowledge to help you here.
```

When `HELP_BOT_TECH_TEAM_HANDLES` is configured as a comma-separated handle
array, the bot appends those mentions. Semicolons are also accepted for
compatibility. For example:

```text
I don't have enough knowledge to help you here. @6529tech @support
```

## 9. Queuing and Timeouts

The bot must not block the original message creation request.

Recommended behavior:

- Add 👀 reaction as soon as the trigger is accepted.
- Queue answer generation asynchronously.
- Set a short user-visible timeout target, for example 20 to 30 seconds.
- If the worker times out, replace 👀 with ⚠️ and post the technical failure
  reply.
- Retry transient provider failures only when retrying will not produce duplicate
  replies.

## 10. Rate Limits and Abuse Controls

Initial controls:

- Per-user trigger limit: more than 5 accepted triggers in 60 seconds records
  the interaction as `SPAM_SUPPRESSED`, reacts `⛔️` to the triggering drop,
  and skips queueing/reply generation.
- Per-wave trigger limit.
- Global bot concurrency limit.
- Maximum prompt/context token budget.
- Skip private/restricted/direct-message waves before reading parent context,
  creating interactions, queueing work, or calling Bedrock.
- Ignore bot mentions inside bot-authored messages.
- Ignore follow-up messages that are trivial acknowledgements.
- Return a bounded no-tech-team reply for obvious impossible grants, prompt
  injection, or private-data requests.

The bot should prefer a polite failure or no-op over spamming a wave.

## 11. Observability

Track:

- trigger count by type
- answer success rate
- no-reliable-source rate
- provider error rate
- timeout rate
- average time from 👀 to final reply
- help index version used
- top unmatched queries for future corpus improvements

Logs must not store hidden prompts, provider secrets, wallet auth tokens, or
private user data beyond what is needed for debugging and abuse controls.

## 12. Rollout Plan

### Phase 1: Spec and Corpus Design - Done

- Draft frontend help index spec.
- Draft backend runtime spec.
- Agree on bot naming and hardcoded handle: `@6529help`.

### Phase 2: V1 Help Bot Plumbing - Done In PR

- Create bot identity.
- Resolve the `@6529help` profile id from the hardcoded handle at runtime; profile existence is the activation gate, with no enable/profile/queue env var.
- Detect explicit `@6529help` mentions.
- Support mention-only replies to another user's question by answering the
  original question drop.
- Add 👀, answer from cached frontend records, replace with ✅.
- Add failure reply path and ⚠️.
- Optionally tag `HELP_BOT_TECH_TEAM_HANDLES` on no-reliable-source replies.
- Trigger on direct replies to bot messages.
- Use Bedrock wording with deterministic fallback when Bedrock is unavailable.
- Fetch and cache the frontend-published `/help-index.json` artifact.
- Add bounded public-data query-intent mode for aggregate questions over the
  backend-owned public query compiler.

### Phase 3: Full Index/RAG Integration - Future

- Add docs chunking, embeddings, and vector/search retrieval over the expanded
  frontend index and any backend-owned business-rule records.
- Add evaluation coverage for common and broad product questions.

### Phase 4: Evaluation and Coverage

- Add eval questions for TDH, wave creation, subscriptions, voting, drops, and
  navigation.
- Track no-reliable-source queries and expand the corpus.

## 13. Open Questions

- Should successful answers keep ✅ forever, or should status reactions expire?
- Which Bedrock model should be approved for initial production use?
