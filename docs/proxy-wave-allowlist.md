# Proxy wave allowlist (bounded agent mandates)

A grantor can delegate `CREATE_DROP_TO_WAVE` to a grantee (an app, agent or
person acting as the grantor) and restrict that grant to an explicit list of
wave ids. The restriction is enforced in the authorization path of every
delegated write that creates or edits a drop.

## Scope

- **Action restricted:** `CREATE_DROP_TO_WAVE` only. Other proxy actions have
  no wave scope; sending `wave_allowlist` with them is a 400.
- **Principal / grant it binds:** the `profile_proxy_actions` row of the
  grantor→grantee proxy. At runtime the subject is the grantee's JWT whose
  `role` is the grantor; the auth context (`src/auth-context.ts`) carries the
  grant as `activeProxyActions[CREATE_DROP_TO_WAVE].wave_allowlist`.
- **Representation:** nullable JSON column `wave_allowlist` on
  `ProfileProxyActionEntity` (`src/entities/IProfileProxyAction.ts`), stored
  as a JSON array of wave ids. `ProfileProxiesDb` decodes it once into
  `string[] | null`; consumers never see raw JSON. No existing column changed.
- **Semantics:**
  - omitted / `null` at creation ⇒ legacy unrestricted grant (deliberate: every
    pre-existing row is `NULL` and keeps behaving as today);
  - non-empty list ⇒ the proxy may create and edit drops as the grantor only
    in those waves;
  - empty list ⇒ **400 at creation/update, never "unrestricted"**;
  - malformed (non-array, non-string or empty ids, duplicates, more than 100
    entries, ids over 100 chars) ⇒ 400 and **the action is not created**
    (Joi in `proxies.routes.ts` and `normalizeWaveAllowlist` in the service),
    so a client can never believe a restricted grant exists when the server
    discarded the restriction;
  - a corrupt stored value decodes as an empty list and fails closed.
- **One grant per pair:** the schema allows one action row per
  (proxy, action type) and revoke→restore reuses the row, so there is exactly
  one `CREATE_DROP_TO_WAVE` grant per grantor→grantee pair. The restriction
  limits _that grant_. A grantee who also holds the grantor's own credential,
  or a grant from another grantor, has that other authority independently;
  the allowlist does not remove it.
- **Revocation / expiry:** unchanged; `isProxyActionActive`
  (`proxy.api.service.ts`) decides whether the grant counts at all. An
  inactive grant fails before the wave check.
- **Visibility and eligibility:** the allowlist never grants visibility,
  group eligibility, admin rights or bypasses content, signature, slow-mode or
  moderation checks. Those still run after the wave check. A listed wave that
  is deleted, hidden from the grantor, or closed for participation is simply
  inert: the write fails exactly as it would for the grantor.
- **Device grants / signed posts:** unavailable in proxy sessions and not used
  for anything here.

## Update semantics (decision)

`PUT /proxies/{proxyId}/actions/{actionId}` accepts `wave_allowlist` as an
optional non-empty list that **replaces** the stored scope (narrowing or
widening to a different explicit list). Omitting the field keeps the stored
scope. `null` is **rejected with 400**: lifting a scope back to "every wave"
is not offered through update, because JSON clients commonly serialise
untouched fields as `null` and that must never silently widen a grant. The
only way to stop a scoped proxy altogether is to revoke the action.
A replacement does not require re-acceptance by the grantee, consistent with
`end_time`/`credit_amount` updates. Whether a deliberate lift should be
allowed (for example via a dedicated endpoint) is left to maintainers.

## Authorization matrix

Row = acting context; column = operation on wave `W`. "✓" = allowed when
every other existing rule (visibility, groups, content, signatures) passes.

| Context                                      | Create in W | Edit drop in W | Reply in W to drop in W | Reply in W to drop in V≠W | Competition entry in W | Mention count in W | Read: `authenticated_user_eligible_to_participate` for W |
| -------------------------------------------- | ----------- | -------------- | ----------------------- | ------------------------- | ---------------------- | ------------------ | -------------------------------------------------------- |
| Grantor acting as themselves                 | ✓           | ✓              | ✓                       | 400 (existing rule)       | ✓                      | ✓                  | as today                                                 |
| Proxy, no `CREATE_DROP_TO_WAVE` grant        | 403         | 403 (new)      | 403                     | 403                       | 403                    | 403                | false                                                    |
| Proxy, legacy grant (`wave_allowlist: null`) | ✓           | ✓              | ✓                       | 400 (existing rule)       | ✓                      | ✓                  | as today                                                 |
| Proxy, scoped grant, W listed                | ✓           | ✓              | ✓                       | 400 (existing rule)       | ✓                      | ✓                  | as today                                                 |
| Proxy, scoped grant, W not listed            | 403         | 403            | 403                     | 403                       | 403                    | 403                | false                                                    |
| Proxy, grant revoked / expired / rejected    | 403         | 403            | 403                     | 403                       | 403                    | 403                | false                                                    |

Error text: `Proxy is not allowed to create drops in this wave` (create,
use-case), `Proxy is not allowed to edit drops in this wave` (edit),
`You are not eligible for this decision action` (competition entry),
`Posting rights are required` (mention count).

## Enforcement points (all delegated drop writes)

| Route / path                                                               | Where the check lands                                                                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /drops`                                                              | `drops.routes.ts`: `hasRightsToPostInWave(newDrop.wave_id)` right after Joi validation, before signature, replay and visibility work.                        |
| `POST /drops/{drop_id}` (edit)                                             | `drops.routes.ts`: the drop's wave id is resolved first, then `hasRightsToPostInWave(waveId)`. Pre-existing gap closed: a proxy now needs the grant to edit. |
| Competition entry submission                                               | `competition-entry.service.ts` → `assertCompetitionGroup(..., waveId)` in `competition-command-access.ts` (wave check before the group gate).                |
| `countAllMentionRecipients`                                                | `create-or-update-drop.use-case.ts`: `hasRightsToPostInWave(waveId)`.                                                                                        |
| Every write through `CreateOrUpdateDropUseCase.execute` (defence in depth) | `assertProxyMayPostInWave`: when the model carries `proxy_id`/`proxy_identity`, the active grant is re-read and `wave_allowlist` checked against `wave_id`.  |
| Reply targets                                                              | Existing rule: a reply must be in the same wave as its target (`verifyReplyDrop`), so a reply cannot escape the scope.                                       |
| Wave description drops                                                     | Created under `CREATE_WAVE`; out of scope.                                                                                                                   |

Read side: `wave-min.helpers.getWaveMinPermissionMask(...).noRightToParticipateIn(waveId)`
and `WavesMappers.waveEntitiesToApiWaves` report
`authenticated_user_eligible(_to_participate)` as `false` for a scoped proxy in
waves outside its list. Shape unchanged.

## Propagation and caching

Authentication contexts are cached in memory per instance for one minute
(`src/api-serverless/src/auth/auth-context-cache.ts`). Creating, updating,
accepting, rejecting, revoking or restoring an action now invalidates the
grantee's cached contexts for that grantor **on the instance that handled the
request**. Other API instances still serve their cached context until it
expires, so a change can take up to 60 seconds to propagate elsewhere. The
use-case re-reads the grant from the database on every proxy write, so the
defence-in-depth check is never stale.

## API

- `ApiCreateNewProfileProxyCreateWaveParticipationDropAction.wave_allowlist`
  (optional, array of string, 1–100 items)
- `ApiProfileProxyAction.wave_allowlist` (required, array of string or null)
- `ApiUpdateProxyActionRequest.wave_allowlist` (optional, array of string,
  1–100 items; `null` rejected)

## Help6529 knowledge authoring facts

- A proxy grant for posting (`CREATE_DROP_TO_WAVE`) can be limited to a list
  of waves. The proxy can then only post and edit the grantor's drops in those
  waves; everywhere else it is refused.
- Grants created without a wave list, and all grants created before wave
  lists existed, allow posting in every wave the grantor can post in.
- A wave list never gives the proxy access to a wave the grantor cannot see
  or post in; the wave's own rules still apply.
- The grantor can replace the list later but cannot clear it; to stop the
  proxy posting entirely, revoke the action. Changes may take up to a minute
  to apply.

The frontend help corpus has no proxy record today; these facts need a
companion entry there before the help bot can answer questions about them.
