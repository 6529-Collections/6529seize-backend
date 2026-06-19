# 6529 Help Bot Runtime

## 1. Objective

Add a 6529 Help Bot, also referred to as the helper chatbot, that can answer
product questions inside Waves. Users can trigger it by mentioning the bot or by
replying directly to a previous bot answer.

The bot should respond quickly with visible status reactions, answer as a reply
to the triggering message, and use a frontend-provided help index plus backend
business-rule records to ground answers.

V1 ships without full RAG. It uses bounded backend seed records with canonical
6529.io URLs, plus an optional Bedrock renderer for natural wording when
configured. The fuller frontend help-index/RAG path remains the next corpus
phase.

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
2. Reply:

```text
I saw this, but I couldn't find a reliable answer from the current 6529 docs. Try rephrasing, or ask in 6529 Tech Feedback.
```

If the bot hits a technical issue, timeout, or provider error:

1. Replace 👀 with ⚠️.
2. Reply:

```text
I saw this, but I hit a temporary issue while looking it up. Please try again in a minute.
```

The bot should not hallucinate a fallback answer when source confidence is low.

## 3. Non-Goals

- Do not answer without a user trigger.
- Do not inspect GitHub or frontend source files during the live answer path.
- Do not train or fine-tune a model for V1.
- Do not provide wallet-specific eligibility answers unless a dedicated
  authenticated tool is added.
- Do not replace human support or moderation.
- Do not merge, deploy to staging, or activate production behavior in this
  PR-ready/no-deploy pass.

## 4. Knowledge Architecture

### 4.1 V1 backend seed records

V1 answers from short backend-owned records for common 6529 topics and routes.
These records are intentionally small so the bot is fast and reliable while the
team learns what users ask.

Initial seeded topics include:

- TDH and network definitions
- Waves and wave creation
- subscriptions and subscription eligibility
- profile subscriptions tab
- REP/CIC and Levels
- delegation
- The Memes
- NextGen

### 4.2 Future frontend-owned help index

The frontend should publish a generated help index containing:

- curated glossary records
- curated UI affordance records
- route records
- chunks from frontend `ops/docs`
- canonical 6529.io links
- source commit SHA and schema version

The backend should sync this artifact into a runtime store and answer from the
latest valid cached copy.

### 4.3 Backend-owned help records

The backend should own records for backend business rules that are not safe to
infer from frontend pages alone. Examples:

- subscription processing behavior
- eligibility concepts where rules are implemented in backend services
- wave and drop permission rules
- rate limit or posting restrictions

These should be short, curated records or generated summaries from backend docs
and tests. Raw code lookup should happen offline during indexing or authoring,
not during a user request.

### 4.4 Agent maintenance contract

Future agents must treat the help bot corpus as part of the user-facing product
surface. When a backend change adds or changes behavior that users may ask
`@6529help` about, update the help bot materials in the same PR.

Backend-owned examples:

- subscription behavior and eligibility concepts
- wave, drop, voting, or permission rules
- posting limits, slow-mode, or rate-limit explanations
- backend-owned product terminology
- canonical URLs for backend-owned reports or tools

For V1, add or update seed records in `src/help-bot/help-bot.knowledge.ts` and
adjust focused help bot tests. Also update this runtime spec when trigger
behavior, failure wording, provider behavior, source ownership, observability,
or coverage expectations change.

If a backend change is user-visible but intentionally should not be answerable
by the bot yet, the PR should say why and whether a follow-up corpus update is
needed.

### 4.5 Retrieval model

The bot should not depend on a predefined list of questions. It should retrieve
records and chunks by:

- exact alias lookup
- keyword search
- vector search
- lightweight intent classification where useful

The live answer prompt should receive only the top relevant snippets, not the
entire corpus.

For V1, retrieval is alias/keyword scoring over the seed records. Direct
follow-up questions first match the current user message; previous bot answer
text is used only as fallback context so old wording does not dominate the next
topic.

## 5. Runtime Flow

### 5.1 Mention flow

```text
message_created
  -> detect @6529help
  -> create interaction row
  -> add 👀 reaction
  -> enqueue help job
  -> worker retrieves context
  -> worker calls LLM
  -> worker posts reply
  -> replace 👀 with ✅
```

### 5.2 Follow-up flow

```text
message_created
  -> parent message is from 6529 Help Bot
  -> message is not a trivial acknowledgement
  -> create interaction row
  -> add 👀 reaction
  -> enqueue help job with previous bot answer context
  -> worker retrieves fresh context for current question
  -> worker calls LLM
  -> worker posts reply
  -> replace 👀 with ✅
```

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
- `wave_id`
- `author_id`
- `parent_bot_drop_id`
- `trigger_type`: `MENTION` or `BOT_REPLY`
- `status`: `SEEN`, `ANSWERING`, `ANSWERED`, `NO_RELIABLE_SOURCE`,
  `FAILED`
- `bot_reply_drop_id`
- `knowledge_version`
- `failure_reason`
- `created_at`
- `updated_at`
- `answer_started_at`
- `completed_at`

Idempotency rules:

- One interaction per triggering message.
- If an interaction exists in `SEEN` or `ANSWERING`, do not enqueue another job.
- If an interaction is `ANSWERED`, do not answer again unless explicit retry
  behavior is added later.
- Bot-authored messages must not trigger the bot.

## 7. LLM Provider

V1 should use a managed LLM provider rather than self-hosting.

Optional V1 provider:

- Amazon Bedrock with Claude or another approved text model.

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
deciding canonical facts or links without retrieved context. If Bedrock is not
configured, or if it fails after a reliable seed record is found, V1 uses the
deterministic seeded answer.

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
I saw this, but I couldn't find a reliable answer from the current 6529 docs. Try rephrasing, or ask in 6529 Tech Feedback.
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

- Per-user trigger limit.
- Per-wave trigger limit.
- Global bot concurrency limit.
- Maximum prompt/context token budget.
- Ignore bot mentions inside bot-authored messages.
- Ignore follow-up messages that are trivial acknowledgements.

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
- Agree on bot naming and handle: `@6529help`.

### Phase 2: V1 Seeded Bot Plumbing - Done In PR

- Create bot identity.
- Detect explicit `@6529help` mentions.
- Add 👀, answer from seeded records, replace with ✅.
- Add failure reply path and ⚠️.
- Trigger on direct replies to bot messages.
- Use optional Bedrock wording when configured, with deterministic fallback.

### Phase 3: Full Index/RAG Integration - Future

- Sync frontend help index.
- Expand backend help records.
- Add vector/search retrieval over frontend/backend docs.
- Add no-reliable-source behavior.

### Phase 4: Evaluation and Coverage

- Add eval questions for TDH, wave creation, subscriptions, voting, drops, and
  navigation.
- Track no-reliable-source queries and expand the corpus.

## 13. Open Questions

- Should successful answers keep ✅ forever, or should status reactions expire?
- Which Bedrock model should be approved for initial production use?
- How should the backend sync the frontend help index: scheduled pull, deploy
  webhook, S3 event, or admin endpoint?
