---
name: deploy-6529
description: Route and execute 6529 backend, frontend, or coupled staging and production releases through an effective Release Bus lane by exact PR head SHA, or use the serialized manual fallback while that target lane reports OFF. Use for staging, deploy, promotion, release merge, turning a lane on or off, recovery, or rollout coordination.
---

# Deploy 6529 Backend

## Live routing gate

1. Run `node ops/scripts/release-bus-status.mjs` at the start and again before
   any readiness or environment mutation. The helper uses authenticated `gh`,
   reads the versioned controls endpoint, verifies hidden safety fences, and
   returns only the two effective automation lanes.
2. Fail closed on an unavailable/malformed API, authentication failure, unknown
   or inconsistent lane state. Never infer ownership from files, raw mode,
   hidden controls, or old output.
3. Route the target environment by the fresh lane result:

| Target lane       | Route                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `STAGING: ON`     | Register the exact candidate with Release Bus                                                                                   |
| `STAGING: OFF`    | Serialized manual staging after the staging drain gate                                                                          |
| `PRODUCTION: ON`  | Explicitly mark an exact `STAGING_VALIDATED` candidate ready for Release Bus production                                         |
| `PRODUCTION: OFF` | Serialized manual production after the production drain gate and explicit owner authorization; staging evidence is not required |

Raw mode and `ALL` are internal emergency fences. They are verified by the
helper but are not normal routing or UI controls. Do not bypass an internal
fence. Both lanes `OFF` means full manual fallback after both drain gates.

## V2 readiness

1. Require an open PR whose exact head and green merge-tree checks are current.
2. Open `/deploy/ui/bus` or call the versioned API. Submit repository, PR,
   branch, exact 40-character head SHA, backend deploy units/DAG edges, and
   candidate dependencies. Backend candidates must list at least one allowlisted
   service. A backend candidate cannot depend on frontend-first deployment.
3. For coupled work, declare the backend candidate as the frontend prerequisite.
   Declare only real ordering edges; independent backend DAG frontier units run
   concurrently.
4. Report candidate ID, immutable SHA, and status. Do not launch a parallel
   manual deploy after v2 accepts the candidate.
5. Wait for `STAGING_VALIDATED`. `STAGING_DEPLOYED` means E2E is still pending
   and is not production evidence.
6. Production is a separate explicit action. Re-resolve each branch, select the
   complete dependency-closed set in one action, and mark ready only when every
   branch still equals its exact staging-validated SHA. Staging validation never
   schedules production automatically. Omitted candidates retain their
   validation evidence and any separate production intent.
   A pre-mutation production replan may create a new audited replacement from
   all currently eligible explicit selections, including a compatible selection
   recorded after the source train was claimed. Verify the replacement event's
   source selection/train mapping and every omitted intent reason. It must never
   infer candidates from staging. After any successful main advance, production
   deploy dispatch, or production E2E, the original exact set is frozen and may
   only resume or recover unchanged. Retain its production lease only while
   dispatched work remains nonterminal; after terminal drain, release the lease
   while the paused train/control continue blocking new claims.
   If `PRODUCTION_REPLAN_INTENT_SCAN_FAILED_CLOSED` reaches its bounded cap,
   stop claiming; after ownership drains, revoke/cancel only owner-authorized
   stale intents or deploy a separately reviewed pagination/cap change. Never
   edit the ledger or silently drop intent.
   During an API-before-reconciler rolling upgrade, the selection parks at
   `READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION`; never rewrite it to the legacy
   ready status to make an older worker claim it.

For staging, v2 reuses exact green PR merge-tree evidence when eligible and
otherwise runs one combined preflight and immutable build. For production, the
default `CANDIDATE_STAGING_EVIDENCE_V1` policy records every selected
candidate's staging train, manifest, and successful E2E operation/run, then
freshly composes and builds the selected set from both current `main` bases.
It does not mutate shared staging or create a `PRODUCTION_QUALIFICATION` child
merely because the selected combination differs from a staging manifest. It
updates `main` only after candidate evidence, fresh checks, immutable artifacts,
and both base refs pass their fences. It never authors or posts release notes;
every production operation emits the autonomous bot's canonical grouping
metadata and finalize signal unless the candidate explicitly opts out.

## Manual fallback while the target lane is OFF

1. Prove the target environment lock is free, no target mutation/E2E workflow
   is active, and every already-dispatched exact operation is terminal. Fetch
   the exact remote target head. Wait; never cancel another actor.
2. Re-fetch immediately before pushing. If a shared ref moved, recompute from
   the new head. Never force-push.
3. Merge the development branch into current `1a-staging`. Deploy required
   backend units in DAG order through `Deploy a service`. Dispatch exactly one
   service at a time and wait for exact success before dispatching the next;
   shared workflow concurrency can cancel sibling runs, even for independent
   DAG-frontier units.
4. For coupled work, verify required backend units before merging/deploying
   frontend.
5. Record exact deployed frontend/backend SHAs before E2E and freeze staging
   until E2E is terminal.
6. With the production lane `OFF`, production requires explicit owner
   authorization but not prior staging deployment or validation. Re-fetch
   `main` and preserve dependency
   order. Pass the same merged PR number and full canonical service set to every
   backend production run; set `release_note_publish=true` only on the final
   sequential service. For an explicitly authorized internal operation that
   must not create a release note, omit the PR/group metadata, set
   `release_note_opt_out=true`, and leave `release_note_publish=false`; opt-out
   and publish are mutually exclusive. Never author or post the note—the
   autonomous bot owns it.

## Monitoring and recovery

- Inspect the exact candidate ID, PR, head SHA, train, failed operation,
  workflow, command/test, and log URL before acting.
- Never infer that membership in a failed train makes a PR the culprit.
- If failure evidence directly identifies that exact candidate/head or a
  changed test, fix it, push a new head, and register that exact new SHA.
- For grouped, `COMBINATION_FAILED`, or otherwise non-attributed staging
  preflight failure, never push a dummy commit. Explicitly re-register the same
  head only after its candidate is terminal and unowned; let the API fail
  closed unless the audited grouped-failure evidence is exact.
- Never start a parallel manual deployment or cancel another actor.
- Report the exact failed command/test, candidate set, and log URL. Hand off
  through durable bus/GitHub status; do not keep an interactive task polling.
- Use train details, operations, workflow links, manifest identity, failure
  class, and recovery message in `/deploy/ui/bus`.
- Infrastructure and retryable exact deployment failures retry the same
  idempotent operation. They do not isolate candidates.
- An ordinary staging combined preflight failure never launches subset
  isolation. After already-dispatched workflows drain, the failing
  repository's NEW group fails once and independent repository candidates
  return to the very next train.
- Group failures do not auto-retry. Re-registering the unchanged exact head is
  the only retry signal, and it succeeds only when fresh green PR evidence and
  immutable registration data match one unowned audited group-failure row
  version. Record the retry id/attempt; never require a dummy commit.
- Active staging trains recheck every NEW exact PR head before further work.
  A moved head stops new dispatch, drains existing workflows without
  cancellation, supersedes the obsolete candidate, and replans unrelated NEW
  candidates.
- A merge conflict marks only the direct candidate `NEEDS_REBASE` and holds
  transitive dependants. Fix the branch and register its new SHA.
- A control-plane defect turns the affected automation lane off and leaves
  candidates unblamed. Keep exact state, wait for its drain gate, use manual
  fallback for that environment, and turn the lane on explicitly after repair.
- Use `node ops/scripts/release-bus-v2-fast-off.mjs --execute` only for an
  emergency hard stop of both lanes. Its raw mode and `ALL` changes are
  intentionally absent from normal UI and routing.
- Failed E2E never creates staging validation. Do not mutate staging while the
  manifest owner still holds the environment lock.
- If either production `main` base moved, v2 must cancel/requeue and freshly
  compose again; never force the recorded composition over a newer ref.
- Once a production train reaches `PRODUCTION_DEPLOYING`, its exact composition
  is already on `main`. Any exhausted deployment retry or production E2E
  failure must pause `PRODUCTION`, fail the selected candidates closed, and
  block later production claims. Do not resume until the recorded main SHAs
  and runtime are reconciled exactly or an explicit rollback is complete;
  never rewrite `main` to hide the failed release.
- `PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED` is an auditable pre-deploy
  composition manifest, not staging validation. Production success still
  requires terminal production-safe read-only E2E.

## Closeout

Report exact candidate SHAs/dependencies, train and operation states, deployed
versions, manifest/E2E evidence, failures or holds, and both effective lane
states. Do
not expose credentials, signed URLs, raw production data, or hidden prompts.
