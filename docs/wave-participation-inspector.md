# Wave participation inspector

`GET /waves/{id}/participation` explains why the current identity can or
cannot perform a chat action in a wave. It returns one decision per supported
action, built from the same policy the drop write path enforces, so an
explanation can never drift from enforcement.

Supported actions:

| action  | Means                                      |
| ------- | ------------------------------------------ |
| `CHAT`  | A top-level chat drop (`drop_type = CHAT`) |
| `REPLY` | A chat drop replying to a drop in the wave |

Participatory (competition) drops are not covered yet.

## Response

```json
{
  "wave_id": "…",
  "evaluated_at": 1760000000000,
  "decisions": [
    {
      "action": "CHAT",
      "allowed": false,
      "reason_code": "SLOW_MODE_COOLDOWN",
      "retry_at": 1760000045000,
      "constraints": {
        "chat_enabled": true,
        "chat_group_required": true,
        "replies_open": false,
        "slow_mode_cooldown_ms": 60000
      },
      "evaluation": "EVALUATED"
    },
    {
      "action": "REPLY",
      "allowed": true,
      "constraints": { "…": "…" },
      "evaluation": "EVALUATED"
    }
  ]
}
```

- `evaluated_at` is the server clock the decisions were made at; compare
  `retry_at` against it rather than against the client clock.
- `constraints` repeats only wave settings everyone who can view the wave
  already sees in `ApiWave.chat` (enabled, whether a chat group is configured,
  open replies, slow-mode cooldown). It never names a group.
- `reason_code` is absent when `allowed` is true. `retry_at` is present only
  with `SLOW_MODE_COOLDOWN`.

## Reason codes

Gates are evaluated in the order the write path applies them; the first
failing gate is the reason.

| Code                 | HTTP on write | Write-path message                                                     | Meaning                                                                                                      |
| -------------------- | ------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `NOT_AUTHENTICATED`  | 403           | `You need to create a profile before you can create a drop`            | No profile is authenticated.                                                                                 |
| `PROXY_LACKS_ACTION` | 403           | `Proxy doesn't have permission to create drops`                        | Acting as a proxy without the `CREATE_DROP_TO_WAVE` action.                                                  |
| `NOT_IN_CHAT_GROUP`  | 403           | `User is not eligible for this wave`                                   | Outside the wave's chat group. For `REPLY` this only applies when the wave does not open replies to viewers. |
| `CHAT_DISABLED`      | 403           | `Chat drops are not allowed in this wave`                              | The wave has chat turned off.                                                                                |
| `LEGACY_DM_CLOSED`   | 403           | `Unencrypted DMs closed on <cutoff>. Start an encrypted chat instead.` | The unencrypted direct-message cutoff has passed (`src/legacy-dm/legacy-dm-retention.ts`).                   |
| `SLOW_MODE_COOLDOWN` | 403           | `Slow mode is enabled. You can create your next chat drop at <ms>`     | The identity's slow-mode cooldown has not lifted; `retry_at` says when. Creator and admins are exempt.       |

The write path (`POST /drops`, `src/drops/create-or-update-drop.use-case.ts`)
returns the same code in its error body (`{ "error": …, "code": … }`), the way
`LEGACY_DM_CLOSED` already did. Messages and status codes are unchanged.

## What the endpoint does not do

- **Visibility is never a reason.** A wave the caller cannot see, or whose
  parent wave they cannot see, is a `404` exactly as `GET /waves/{id}` answers,
  before any decision is made. Nothing in the response reveals a hidden wave
  or a private group definition.
- **`allowed: true` is not a promise.** Payload-specific validation still
  applies on write: the reply target must be a drop of this wave the author can
  see, links may be disallowed, signatures, media, metadata, content limits and
  moderation are checked, and a proxy still needs its action at execution time.
- **Slow mode is reserved atomically on write.** `reserveWaveChatDropCooldown`
  (table `wave_chat_drop_cooldowns`) is the source of truth; `retry_at` is the
  current view of the same row. A write between inspection and submission can
  move it.
- **Membership is re-read at write time.** If group membership changes between
  inspection and the drop, the write path still denies (or allows) on the live
  membership. Inspection grants nothing.
- **Unavailable membership is never a denial.** When group eligibility cannot
  be evaluated (`UserGroupsService` fails closed with 503, see
  `docs/eligible-groups-coordination.md`) the endpoint answers `503` just like
  the write path. The `evaluation: UNAVAILABLE` value exists in the shared
  decision type and the API enum for callers that evaluate a decision with
  unknown membership; the HTTP endpoint currently never emits it because the
  visibility check needs membership first. Clients should treat both the same:
  retry later, do not show a reason.

## Identity and proxies

The decision is made for the acting profile: the proxied identity when the
caller acts as a proxy. Visibility uses the ordinary wave read context (a
proxy without `READ_WAVE` is treated as anonymous for visibility, as on
`GET /waves/{id}`). A proxy without `CREATE_DROP_TO_WAVE` gets
`PROXY_LACKS_ACTION`; a proxy with it is judged on the acting profile's
groups, as the write path does.

## Where the policy lives

- `src/waves/wave-participation-decision.ts`: pure, no I/O.
  `evaluateWavePolicyDecision` applies the gates (chat group, chat enabled, DM
  cutoff, slow mode) with the existing helpers (`isWaveChatGroupMember`,
  `canReplyInWaveChat`, `resolveNextDropAllowed`, `isWaveCreatorOrAdmin`).
  `evaluateWaveParticipationDecision` adds the identity gates and the
  `UNAVAILABLE` evaluation.
- `ApiWave.chat.authenticated_user_eligible`,
  `ApiWave.chat.replies.authenticated_user_eligible`,
  `ApiWave.chat.next_drop_allowed`, `ApiWaveOverview` context `can_chat`,
  `can_reply`, `next_drop_allowed` and `ApiWaveMin`
  `authenticated_user_eligible_to_chat` / `_to_reply` derive from the policy
  decision (visibility composed on top where the field had it). Their values
  are unchanged; `wave-participation-mapper-equivalence.test.ts` sweeps wave
  configurations against the previous formulas.
- `src/api-serverless/src/waves/wave-participation.handlers.ts`: the
  generated `x-6529-router` route.

Tests: `src/waves/wave-participation-decision.test.ts` (matrix and
properties), `src/drops/create-or-update-drop-participation-decision.test.ts`
(the use case throws iff the decision denies, with the same code, plus
membership and cooldown changing between inspection and write),
`src/api-serverless/src/waves/wave-participation-handlers.test.ts` (404 on
hidden wave or parent, 503 propagation, proxies, cooldown, DM cutoff).

## Help6529 knowledge authoring facts

- Posting a top-level chat drop always requires being in the wave's chat
  group when one is configured. Open replies let everyone who can view the
  wave reply, but not start top-level drops.
- A wave with chat turned off accepts no chat drops or replies, for anyone.
- Slow mode applies per identity and per wave to chat drops and replies, also
  to open repliers outside the chat group. The wave creator and admin-group
  members are exempt. The next allowed time is `next_drop_allowed` on the wave
  and `retry_at` on a `SLOW_MODE_COOLDOWN` decision.
- Unencrypted direct messages take no new messages from the retention cutoff
  (`LEGACY_DM_CLOSED`); start an encrypted chat instead.
- A proxy needs the "create drop" action to post on someone's behalf; without
  it the answer is `PROXY_LACKS_ACTION`.
- A wave the user cannot see answers "not found"; the inspector never
  explains hidden waves or names private groups.
- "Allowed" means the policy gates pass right now. The drop can still be
  rejected for its content, an invisible reply target, disallowed links, a
  missing signature, or a cooldown reserved in the meantime.
- When membership cannot be evaluated the answer is a temporary error (503),
  not a denial; try again shortly.

The frontend help corpus (`ops/help/help-index.json`, published as
`/help-index.json`) needs a companion record mirroring these facts; it is not
part of this backend change.
