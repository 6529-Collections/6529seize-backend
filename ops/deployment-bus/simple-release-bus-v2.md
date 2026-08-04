# Simple Release Bus v2

Simple Release Bus v2 is the deployment authority for exact frontend/backend
candidate SHAs when the target environment's effective lane is `ON`.

## Route every request from live state

Run:

```bash
node ops/scripts/release-bus-status.mjs
```

The helper reads `/deploy/release-bus-v2/controls`, verifies the hidden safety
fences, and fails closed if the versioned status is unavailable, malformed, or
internally inconsistent. Its operator-facing result contains only:

| Effective lane | `ON`                                                                                | `OFF`                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Staging        | Register exact candidates with Release Bus                                          | If `changeable: true`, serialized manual staging after the staging drain gate                                                                  |
| Production     | Separately select an exact `STAGING_VALIDATED` candidate for Release Bus production | If `changeable: true`, serialized manual production after the production drain gate and explicit owner authorization; no staging evidence gate |

The drain gate requires the target environment lock to be free, no target
mutation/E2E workflow to be active, and every already-dispatched exact
operation to be terminal. Both lanes `OFF` means full manual fallback after both
drain gates. Raw `RELEASE_BUS_V2_MODE` and `ALL` remain internal emergency
fences; they are not normal routing or UI controls and must never be bypassed.

There is no inferred control-plane or self-upgrade exception. While a target
lane is `ON`, every deploy for that environment—including API, `releaseBus`,
cleaner/reconciler, and other control-plane changes—must carry a valid Release
Bus operation identity. Manual workflows reject before checkout, build, ref,
credential, or deployment mutation unless the helper authoritatively reports
the affected lane `OFF` with `changeable: true`, no hidden emergency fence
blocks fallback, and the drain gate passes. If Release Bus cannot safely
self-deploy while `ON`, stop for explicit owner direction.

## Dashboard read model

`/deploy/ui/bus` presents Staging and Production as the two operator-facing
lanes. Each lane shows its effective `ON`/`OFF` state, the exact frontend and
backend SHAs currently deployed, the last successfully validated exact SHAs,
and three train views:

- the currently active train, if one has been claimed;
- the projected next train if the queue does not change; and
- terminal train history, loaded incrementally.

The projected train is read-only planning output. It is never claim evidence and
may change until the reconciler persists a train. Train cards split backend and
frontend candidates and retain exact PR, SHA, status, membership, dependency,
and backend deployment-DAG data. Locks, manifests, workflow runs, operations,
errors, and durable events remain available inside the train's expandable
diagnostics rather than as separate top-level dashboards.

The shared Pull requests view lists every registered exact candidate and can be
filtered by PR number or status. Public users can inspect this state without a
GitHub token. Authentication reveals only the lane and candidate actions that
can mutate state. The UI is a human read model; agents and scripts must continue
to route and validate mutations from the versioned helper and API response.

## Candidate contract

Register through `/deploy/ui/bus` or
`POST /deploy/release-bus-v2/candidates` with:

- repository, open PR number, branch, and exact head SHA;
- backend allowlisted deploy units and dependency DAG edges;
- candidate dependencies and their staging/production scope.

Registration verifies the branch, exact PR merge tree, and green check evidence.
An exact available PR artifact is accepted only from the same green workflow run
and digest. A new head supersedes the older immutable candidate and explains the
old GitHub status.

While global mode is `OFF`, the public contract above remains disabled. The
operator beta is a fail-closed exception available only when the deployed API
and reconciler share a valid `RELEASE_BUS_V2_BETA_ALLOWLIST`. Each registration
must supply the exact preassigned UUIDv4 `candidate_id`; repository, branch,
requesting GitHub operator, and lane must all match the configuration. Entries
for one bounded test share one `test_id` and one operator. Ordinary developers,
unlisted candidates, and malformed configuration remain on the `OFF` manual
route.

Backend candidates cannot require frontend-first deployment. For coupled work,
register backend first and declare it as the frontend prerequisite.

## Staging lifecycle

1. Registration records one open PR at its exact current head. The scheduler
   selects only the newest registered exact SHA for each repository/PR and
   combines that dependency-closed NEW set with the exact current
   `1a-staging` state. Unchanged live candidates are immutable input evidence,
   not new work to diagnose or mutate.
2. Frontend/backend composition and preparation run concurrently.
3. Exact green PR merge-tree evidence is reused when eligible; train artifact
   bytes are freshly built for the exact staging composition. Backend
   preparation installs dependencies once and builds/packages only selected
   deploy units. Repository-wide lint, typecheck, test inventory, and full Jest
   matrices remain PR CI gates and never run in a normal train. Ordinary
   staging never bisects a failed repository or builds diagnostic subsets.
   The resulting immutable artifact is bound to this exact train. The
   `environment-bound-v3` deploy-input guards reject a mismatched train
   identity before authorization or checkout. The legacy-v2 input shim keeps
   its immutable exact-manifest checks for trains claimed before the new
   artifact policy; it is compatibility for those frozen trains, not permission
   to reuse their bytes in a new train.
   For an affected repository, the staging release commit has the recorded
   current `1a-staging` SHA as its first parent and the dependency-closed
   composition as its second parent, so the shared branch can only fast-forward
   without losing the cumulative tree. Normal staging composition starts from
   that recorded parent and merges current `main` plus every admitted candidate;
   only rollback deliberately binds a last-validated replacement tree.
4. Preparation may finish while another train owns staging.
5. The train acquires the staging lock and repeats the idle/ref snapshot.
   Under that lock it binds every unchanged repository to the exact current
   `1a-staging` ref, so a frontend-only or backend-only manifest describes the
   environment E2E actually sees rather than the unrelated `main` ref. A
   carry-forward-only repository must already have `composed_sha` equal to that
   exact ref or the train fails before any ref advance or deployment dispatch.
6. Before any deployment dispatch, each affected `1a-staging` ref advances to
   the immutable release commit through a dedicated operation-owned workflow.
   It authorizes the exact train/attempt before its first ref read, proves the
   recorded base is an ancestor of the immutable target, performs an exact
   leased fast-forward, and reports the observed target SHA. The workflow uses
   its repository `GITHUB_TOKEN`, preventing this Release Bus-owned ref update
   from recursively triggering the legacy staging deploy/E2E chain. Unaffected
   repositories do not move. A stale base, moved ref, non-fast-forward target,
   or lease conflict starts no train deployment, records exact drift, and
   pauses only staging for serialized recovery.
7. Independent backend DAG frontier units deploy concurrently; dependency edges
   serialize only required units. Dependent frontend deploys after backend.
8. The controller persists `STAGING_DEPLOYED` with exact SHAs, artifact
   digests, services, operation runs, and timings.
9. E2E runs from an immutable ref at the exact frontend release SHA and receives
   the paired manifest identity. Staging remains locked until E2E is terminal.
10. Only E2E success plus exact agreement among both `1a-staging` refs,
    deployed-runtime evidence, the manifest, and E2E produces
    `STAGING_VALIDATED`.

Ref-advance operations are durable and independently keyed per repository and
attempt, so backend and frontend ref operations may share one DAG frontier
without sharing a concurrency identity. A crash after GitHub accepts a leased
fast-forward but before the operation or train transition is stored re-reads
the ref, records the completed mutation, and continues with the same deployment
idempotency keys. A post-advance deploy or E2E failure never validates the
failed manifest. Rollback composes a new immutable restore commit whose first
parent is the failed staging release and whose tree is the last validated
release, advances `1a-staging` forward, redeploys that exact commit, and
requires rollback E2E before releasing the staging lock. Recovery never
rewrites shared-ref history or loses the failed train's durable intent.

If the first cumulative train fails after staging mutation while the
authoritative state is `CLEAN_MAIN`, there is no historical manifest to guess
as a rollback target. The train becomes a staging-only recovery-required
failure, only its NEW candidates return to `READY_FOR_STAGING`, carry-forward
intent remains unchanged, and the staging lease remains held until every
already-dispatched operation is terminal. A concurrent staging-state
row-version change is retried optimistically and may not pause `ALL` or mutate
production.

Before every further preparation or environment operation, an active staging
train rechecks every NEW PR head. If a head moved or a newer exact registration
exists, the old candidate is superseded immediately. No more operations are
dispatched for that train. Already-dispatched workflows are observed until
terminal without cancellation; then unrelated NEW candidates return to the
very next train. If shared staging mutation already began, the exact last
validated manifest is restored and E2E-validated before ownership is released.

`STAGING_DEPLOYED` and `STAGING_VALIDATED` are separate milestones.
`STAGING_VALIDATED` is historical certification. It does not mean the
candidate is present in the current shared staging runtime. The candidate
`staging_live_state`/`staging_live_manifest_id` fields and the singleton
`staging_state` returned by the controls endpoint are authoritative for current
presence.

The first cumulative claim after rollout bootstraps the singleton only from an
exact current pair of `1a-staging` refs, a matching terminal
`STAGING_VALIDATED` manifest, its successful manifest-bound E2E operation, and
the exact immutable candidate identities recorded by that manifest. Missing or
ambiguous evidence prevents a new claim. An already-claimed legacy train is
allowed to finish under its immutable policy before bootstrap.

Supersession replaces the old exact candidate only when the cumulative
replacement manifest validates. Explicit removal and safe absorption into
`main` are the only other ordinary ways to leave the admitted set; both require
an audited operator request. The removed candidate's declared units are
redeployed from the new candidate-free composition so prior runtime bytes
cannot survive. Production selection does not change staging membership.

Every staging and legacy production-qualification train records a
`STAGING_IDLE_HANDSHAKE` under `staging-environment`. After E2E succeeds, the
reconciler rechecks both exact staging refs and all staging deploy/E2E workflow
history created since the pre-lock snapshot, ignoring only the train's exact
run IDs. Missing or changed evidence fails the mixed manifest and pauses v2;
it can never become `STAGING_VALIDATED`. Operator beta emits the existing
`BETA_STAGING_*` audit events additively.

### Exact deployed-baseline adoption

`POST /deploy/release-bus-v2/maintenance/adopt-exact-staging-baseline` is an
operator-only, one-shot recovery primitive for a separately coordinated manual
staging freeze. It is not an ordinary train or a deployment mechanism. Both
effective lanes must remain independently `OFF` and changeable, `ALL` must be
unpaused, the existing `staging-environment` lock must be wholly free, and all
staging trains, operations, deploy workflows, and E2E runs must already be
drained.

Before moving either staging ref or dispatching either manual deployment, the
operator prepares an immutable, expiring intent. The request supplies a UUID v4
idempotency key, expiry, exact authoritative staging-state row version, target
frontend/backend `1a-staging` refs and SHAs, target runtime SHAs, the required
backend deployment unit/SHA, and an explicit zero-or-known candidate inventory
with row versions. The one-shot contract currently permits exactly the `api`
unit because its deployed commit is independently runtime-verifiable; a
non-API unit cannot be accepted on workflow success alone. Preparation verifies
OFF/changeable controls, a drained and unlocked staging environment, exact
authoritative state and candidate identity/membership, then writes only the
audited intent event. Target refs and runtimes are expected to move later
during the frozen deployments, so preparation creates no train, manifest,
operation, lease, ref mutation, or deployment.

Every ordinary manual staging backend deployment sends one authenticated
terminal callback. A successful callback advances only the unique unexpired
intent whose backend ref, SHA, unit, GitHub run, attempt and runtime are exact.
A failed, stale, moved, duplicate-different, or ambiguous callback fails that
intent closed. With no matching intent, the ordinary manual workflow receives
`NO_MATCH` and retains its existing behavior. The additive callback step is
non-blocking for the ordinary manual deploy job: an unavailable callback stays
visible as a failed step, records no evidence, and therefore prevents the
adoption from freezing without converting an unrelated deploy into a failure.

The normal frontend `Web Deploy - STAGING` success still triggers
`staging-e2e.yml` through `workflow_run`. Its trusted decision job performs one
authenticated lookup for the exact upstream deploy run/ref/SHA:

- no active intent returns `LEGACY`, so the existing expensive automatic E2E
  runs unchanged;
- one unique exact unexpired intent records exact deployment/runtime evidence
  and an idempotent `DEFERRED` event, then exits successfully without running
  the expensive packs;
- stale, moved, expired, malformed, ambiguous, or identity-mismatched evidence
  fails the workflow closed without validating or adopting anything.

Whichever exact deployment event completes the required evidence set last
revalidates the drained controls, state version, target refs, target runtimes,
candidate membership and staging lock. One transaction then creates the real
`ADOPT_EXACT_DEPLOYED_BASELINE_V1` train, acquires only the existing staging
lock, freezes the immutable manifest and creates exactly one `E2E_STAGING`
operation. The existing operation reconciler dispatches exactly one
manifest-bound `staging-e2e.yml` `workflow_dispatch`. Workflow concurrency has
`cancel-in-progress: false`; if the frontend event was last, the bound run
queues behind the short automatic decision run. There is no polling runner,
second expensive E2E, synthetic proof train, cancellation, bypass, new shared
lease protocol, or manual-workflow guard.

The bound operation uses the exact existing attempt identity
`rb2:<adoption-id>:baseline-adoption-e2e:staging:a1`; ordinary E2E operation
keys cannot enter its terminal adoption handler.

Only one exact successful E2E operation, unchanged refs and runtimes, unchanged
staging state/candidate row versions, unchanged OFF controls, and retained
staging-lock ownership permit the final transaction. That transaction changes
the manifest/train to `STAGING_VALIDATED`, CAS-commits the exact pair as
authoritative `LIVE` staging state (including valid zero-candidate membership),
and updates only the selected candidates' derived staging evidence/live fields.
Any stale, malformed, failed, duplicate, or ambiguous evidence fails the
adoption, releases its staging lock, and leaves authoritative staging state and
developer/production intent unchanged. Retrying the same idempotency key
or callback returns the same immutable attempt and cannot dispatch a second
bound run; a failed attempt is never automatically replaced. This capability
must be deployed while lanes are OFF, but must not be invoked until the owner
separately authorizes and holds the brief manual freeze.

Lifecycle discovery considers only the maximum two-hour intent-validity
window. Older immutable terminal audit events remain stored but cannot hide or
brick a currently valid intent; saturation inside that live window still fails
closed.

## Production lifecycle

Staging validation never creates production readiness. An operator explicitly
selects one or more unchanged exact candidates through the Deploy UI or
`POST /deploy/release-bus-v2/production-selections`. The action is atomic: all
selected candidates share one `production_selection_id`, and every selected
candidate must still be `STAGING_VALIDATED` at the submitted head SHA. The
only retry exception is a new explicit selection of an unchanged `FAILED`
candidate whose latest candidate-evidence production train failed an immutable
artifact preflight while containing only terminal compose/preflight operations.
Release Bus locks the terminal train and its operation range, binds its durable
membership to the locked exact candidate row and exact historical staging
train/manifest/E2E evidence, revalidates the unchanged branch head, creates a
new production-selection identity, and records the failed train as the retry
source. The retry then freshly composes and builds an artifact bound to that new
production train; it reuses only the locked source/evidence and never the failed
train's artifact bytes. Selection IDs remain attempt-level audit provenance;
eligibility does not trust an event payload as authoritative state. Any empty
operation range, deploy, E2E, ref-mutation, unknown, or nonterminal operation
makes the failure ineligible for this path.

The selection must be transitively dependency-closed. A production-scoped
prerequisite must either be selected in the same action or already be terminal
`PRODUCTION_DEPLOYED` with a production manifest containing that exact
candidate/repository/PR/head identity and successful production E2E. Omitted
unrelated candidates keep their staging evidence and separate production
intent.

If either production base moves before irreversible production mutation, the
old train is cancelled without changing its immutable membership and its exact
explicit intents move to `WAITING_FOR_PRODUCTION_REPLAN`. The next scheduler
transaction creates a new replacement selection and train from every currently
eligible explicit production intent, including compatible selections committed
after the old train was claimed. It locks and rechecks exact heads, staging
train/manifest/E2E evidence, dependencies, ownership, and both current
production bases. Audit events map every included candidate and source
selection/train to the replacement and retain every omitted intent with its
exact reason. Revoked, superseded, moved, stale-evidence, dependency-incomplete,
or concurrently owned candidates are never inferred from staging and are not
silently included.

If `PRODUCTION_REPLAN_INTENT_SCAN_FAILED_CLOSED` reports the 500-row scan cap,
no replacement may claim. Wait for production ownership to drain, inspect every
explicit ready/held intent, and use the authenticated revoke/cancel actions
only for owner-authorized stale intents until the bounded scan is complete.
Otherwise deploy a separately reviewed cap/pagination change. Never edit the
ledger, discard intent, or split a dependency set merely to unblock the queue.

The replacement boundary closes as soon as any `ADVANCE_MAIN_*` succeeds, a
production deploy is dispatched, or production E2E exists. After that boundary,
the original exact set remains frozen and only that train may resume or recover;
an active train is never broadened in place. A nonterminal dispatched operation
retains the production-environment lease while it drains. Once all recorded
work is terminal, the frozen/paused train releases that lease; the active train
and paused `PRODUCTION` control still block every new claim until exact recovery.

New production trains use `CANDIDATE_STAGING_EVIDENCE_V1`:

- resolve and persist, per selected candidate, candidate ID, repository, PR,
  head SHA, staging train, validated manifest identity, and the successful
  staging E2E operation/run;
- freshly compose both repositories against the current trusted `main` bases.
  Frontend and backend preparation may run concurrently. A candidate's old PR
  artifact or an exact combined staging artifact is never reused for ordinary
  production qualification. The production deploy consumes only the freshly
  built exact production-train artifact and rejects every cross-train artifact
  identity before authorization or checkout;
- fail closed on moved candidate heads, superseded or ambiguous evidence,
  missing staging E2E/artifact identity, an invalid dependency DAG, composition
  conflicts, failed checks/builds, artifact mismatch, or either stale
  production base;
- persist a `PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED` manifest containing the
  policy and exact evidence mapping. This is not a staging qualification and
  does not mutate shared staging;
- never create `PRODUCTION_QUALIFICATION` or
  `WAITING_FOR_PRODUCTION_REPLAN` merely because the selected set differs from
  a current or validated staging manifest;
- serialize production ownership, advance only compare-and-swap exact tested
  commits, deploy immutable artifacts in DAG order, verify exact versions, and
  dispatch mandatory production-safe read-only E2E;
- use the distinct `production-environment` lock and production-scoped
  frontend/backend workflow concurrency. An unrelated staging train keeps its
  own `staging-environment` lock and staging-scoped workflow groups, so ordinary
  production does not wait on unrelated staging activity;
- create `PRODUCTION_DEPLOYED` only after that E2E is terminal-successful.

Trains claimed before this policy deployment have a null policy and continue
under their immutable legacy exact-manifest/qualification behavior. That
compatibility path is not selectable for new ordinary production trains.

The dedicated Release Bus GitHub App must be an `always` bypass actor on the
default-branch ruleset in both repositories. V2 uses that narrowly scoped App
to perform a non-force fast-forward to the exact staging-validated commit; a
pull-request-only bypass would require GitHub to manufacture a different merge
commit and therefore fails closed. Human and team bypass actors remain
pull-request-only. The compensating controls are enforced in code: the App can
write only the explicit shared/release-bus ref allowlist, and every shared-ref
update is a non-force compare-and-swap from the recorded old SHA.

V2 never authors or posts release notes itself. Production operations must feed
the existing autonomous release-note bot complete, canonical grouping metadata
and an idempotent finalize signal. Internal operational candidates may opt out
explicitly.

## Failure behavior

| Class                         | Behavior                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate merge/test          | Before shared mutation, fail the cumulative train closed and leave the last validated admitted manifest live; mark only the new direct candidate `NEEDS_REBASE` as applicable                                                                                                                        |
| Ordinary staging preflight    | After already-running workflows drain, fail the affected repository's NEW candidate group once, hold only dependants, and return independent repository candidates to the next train; never dispatch subset-isolation workflows                                                                      |
| Infrastructure                | Bounded idempotent retry; no candidate isolation                                                                                                                                                                                                                                                     |
| Retryable deployment          | Retry only the failed operation; preserve successful sibling evidence                                                                                                                                                                                                                                |
| Control plane                 | Fail the train, preserve or requeue exact candidates, turn the affected automation lane off where safe, release its environment lock only after every operation is terminal, and permit manual fallback only after the lane drain gate                                                               |
| E2E                           | Keep the failed manifest unvalidated and forward-CAS/deploy/E2E an immutable restore commit with the exact last validated live tree under the same staging lock; commit no admission change until restoration validates                                                                               |
| Production preflight          | Fail before shared mutation. A later explicit exact-SHA selection may retry only after the unchanged staging evidence is revalidated and the locked failed train contains only terminal compose/preflight operations; audit both selection identities and the failed source train                    |
| Production base moved         | Before irreversible mutation, transactionally preserve explicit intent and form a new audited replacement from all currently eligible dependency-closed selections; retain every omission reason. After irreversible mutation, freeze the original exact set and pause production for exact recovery |
| Production after main advance | Fail selected candidates closed, pause `PRODUCTION`, and block later production claims. `main` remains truthful and is never rewritten; an operator must prove the recorded exact main/runtime parity or complete an explicit rollback before resuming                                               |

Every pending GitHub status must map to a visible candidate/train/operation state
and recovery message. Duplicate callbacks and worker invocations reuse immutable
operation identities and never repeat completed mutations.

Grouped staging preflight failures never auto-retry. A developer may explicitly
register the unchanged exact head again. The API rechecks the current branch,
green PR evidence, immutable deploy plan, and dependencies, then requeues only
an unowned `FAILED` candidate whose current row version is tied to one audited
`STAGING_REPOSITORY_PREFLIGHT_GROUP_FAILED` event and one terminal source train.
The failed train remains immutable, and every retry receives a distinct
auditable retry id and attempt number. Ambiguous evidence, moved/superseded
heads, changed registration evidence, and active ownership fail closed.

### Deterministic failed-train recovery

Start from the failed train detail in `/deploy/ui/bus`, not from an assumption
about which PR caused it. Record the exact candidate ID, repository/PR/head SHA,
complete candidate set and membership dispositions, failed operation and
attempt, workflow/run and log URL, and the exact failed command, test, or job
step. Membership in a failed train is only composition evidence; it does not
attribute the failure to every member or to any one member.

If the logs directly identify one exact candidate/head or a test changed by
that head, fix that branch, push a real new head, wait for current green PR
evidence, and register that exact new SHA. Do not retry the obsolete head.

If the result is grouped, `COMBINATION_FAILED`, or otherwise cannot attribute
the repository preflight to one candidate, do not push a dummy commit. Wait
until the failed candidate is terminal and unowned, then use **Retry audited
grouped failure at same SHA** in the Deploy UI or submit the same immutable
registration again to `POST /deploy/release-bus-v2/candidates`. The service
accepts only the single audited grouped repository-preflight failure contract
described above and creates a new retry/attempt identity; ambiguous history,
active ownership, moved/superseded heads, or changed evidence is rejected.
There is no automatic retry loop.

Do not cancel another actor or start a parallel manual deployment after the bus
accepted a candidate. Report the exact failed command/test, candidate set, and
log URL once, then rely on the durable candidate/train/operation events and
GitHub status for follow-up rather than keeping an interactive task polling.

The backend recovery contract does not close a separate frontend App PR CI
coverage defect. **Mandatory frontend successor task:** create a focused
frontend PR that updates `.github/workflows/app-pr-ci.yml` so a change to
`tests/packs.manifest.cjs`, `scripts/sync-e2e-manifest.cjs`, or either generated
consumer always runs `./bin/6529 run e2e-manifest:check`, and add a workflow
contract regression proving those paths trigger the check. The current related
Jest changed-file selector admits only `*.js`, `*.jsx`, `*.ts`, and `*.tsx`;
therefore `tests/packs.manifest.cjs` can bypass that contract today. This
successor must land before App PR CI can be treated as evidence that manifest
edits cannot poison a staging train.

The operator-only
`POST /deploy/release-bus-v2/maintenance/repair-current-staging-candidates`
action repairs candidate ledger corruption only by deriving
`STAGING_VALIDATED`/`LIVE` from the singleton's exact current
`STAGING_VALIDATED` manifest, successful manifest-bound E2E, immutable
repository/PR/head membership, and terminal train. It acquires the scheduler
and both environment fences, rejects active trains or ambiguous evidence, is
idempotent, and emits an audit event for every derived change. Send
`{"dry_run":true}`
without a candidate list to discover every repairable mismatch in the exact
current manifest without mutating candidates, locks, or audit rows. Execution
must send the explicit repository/PR/head tuples copied from that report, so a
superseded older head that is absent from the current manifest is never
restored. Dry-run discovery is allowed while v2 is `OFF`, but execution is
rejected until v2 is enabled. The execution response reports attempted,
succeeded, and failed GitHub status publications with every failed exact
candidate identity. `newly_derived` counts rows changed by this execution;
`reasserted` counts already-correct rows whose status is intentionally
republished so an idempotent retry can recover a prior GitHub outage. A nonzero
failure count requires operator follow-up even though the durable ledger repair
already committed.

### Logical candidate deregistration

The operator-only
`POST /deploy/release-bus-v2/maintenance/deregister-all-candidates` action has
separate `PREPARE` and `EXECUTE` phases. It is an exceptional logical ledger
reset, not a staging removal deployment. Preparation is read-only and returns
the exact active-intent candidate inventory digest, every active-intent
candidate row version, every control/lock row version, the staging-state row
version, and the observed frontend/backend `1a-staging` refs. Active intent is
every nonterminal status plus the narrow `SUPERSEDED` case that is still
semantically recoverable production intent: no current train, an explicit
production request, staging evidence, and the latest branch-move supersession
event records a deleted head. The reconciler can otherwise restore that exact
row to production readiness, so deregistration must include it. Immutable
`PRODUCTION_DEPLOYED`, `CANCELLED`, `DEREGISTERED`, and all other terminal
`SUPERSEDED` history is excluded and preserved byte-for-byte. Execution must
repeat that complete plan. A preparation with zero active-intent targets
remains executable (`candidate_count: 0`) solely to atomically detach the
authoritative staging singleton before a clean-main bootstrap. The empty
execution changes no candidate row, preserves immutable history, and still
requires the exact controls, locks, trains, operations, workflow/ref fence,
staging-state version, empty-inventory digest, and post-commit audit checks
described below. Its global audit event records the zero candidate count.

Execution is allowed only when `ALL` is unpaused, both independently changeable
lanes are paused `OFF`, all three v2 locks are wholly free, all trains and
operations are terminal, and backend/frontend staging and production
mutation/E2E workflows are inactive. It temporarily owns all three exact locks,
rechecks the workflow/ref fence, and transactionally verifies the supplied
control, lock, singleton, candidate-set, digest, and row versions. The
transaction uses a status-indexed locking read over every mutable candidate
status, excluding only immutable `PRODUCTION_DEPLOYED`, `CANCELLED`, and
`DEREGISTERED` history. Under the database's verified `REPEATABLE-READ`
isolation, the resulting next-key locks fence inserts into every active-intent
status range; a newly admitted target therefore cannot escape the exact CAS.
Latest branch-move events for all `SUPERSEDED` rows are read in one batched
query while that fence is held.

The transaction changes only active-intent targets to `DEREGISTERED`, clears
their queue, current-train, admission, transition, live-manifest, and
production-intent fields, and records `staging_live_state=DETACHED`.
Pre-existing terminal-history rows are preserved byte-for-byte, including
status, timestamps, live-history fields, and `row_version`. Exact candidate
identity, PR evidence, deploy plans, dependencies, historical staging
validation pointers, trains, operations, manifests, and prior events are also
preserved. The singleton becomes `DETACHED_MANUAL_OWNERSHIP`: its last
validated manifest is retained as history, while its current manifest and
current SHA/ref fields are cleared. Global and per-target events record the
before-state and active-inventory digest. Each per-target event records every
cleared or replaced field, including current train, staging live timestamps and
transition request metadata, production requester/selection, and hold reason,
and the supersession timestamp, so the logical change is reconstructable
one-to-one. Exact-head re-registration also clears that stale supersession
marker before a new staging cycle, preventing recovered deleted-branch intent
from remaining permanently ineligible for production. No Git ref, artifact,
workflow, deployment, E2E, release note, or immutable history is mutated.

The database commit is the mutation boundary. If a post-commit GitHub/ref
verification, supplemental audit publication, or maintenance-lease cleanup
fails, the API response must say `outcome: COMMITTED` and `committed: true`,
include the immutable `deregistration_id`, and report `UNKNOWN_DETACHED`.
Failures before that boundary say `outcome: NOT_COMMITTED`,
`committed: false`, and `UNKNOWN_UNCHANGED`, with no deregistration ID.
Operators must treat a `COMMITTED` error as a committed deregistration and
audit by ID; a generic failure must never imply that the database mutation did
not occur.

`DETACHED` means physical staging presence is deliberately unknown. It must
never be rewritten to `NOT_LIVE`, `CLEAN_MAIN`, or a historical live manifest
merely because the bus stopped owning those candidates. While detached, new
registration and every staging claim fail closed. An old validated manifest
whose SHAs still match the staging refs must not resurrect its members. The
only automatic exit is when both exact `1a-staging` refs equal the current
frontend/backend `main` bases; that proves clean main and changes deregistered
detached targets to `NOT_LIVE` without restoring historical membership.
Terminal-history rows remain byte-for-byte unchanged; once the singleton is
`CLEAN_MAIN`, their historical `LIVE` fields are not authoritative because
current membership is bound to the singleton's exact current manifest.
If serialized manual fallback changed either staging ref to anything else, the
bus remains detached until an authorized normalization deploy makes both refs
exact current main. Re-registering a deregistered exact head after clean
bootstrap requires fresh current branch and green PR evidence.

The new literals fit the existing candidate/status/live-state and singleton
`varchar` widths; this contract adds no DDL. Do not execute the maintenance
action during a mixed API/reconciler rollout. Keep both lane controls paused
until the API, reconciler, generated contracts, and UI all understand
`DEREGISTERED`, `DETACHED`, `DETACHED_MANUAL_OWNERSHIP`, and
`ADOPT_EXACT_DEPLOYED_BASELINE_V1`. An older
reconciler cannot claim while the lane controls remain paused, so either
deployment order is safe during that fenced window; resumption requires exact
new-runtime parity.

## Operator rollout and rollback

Deploy additive changes in this order: database migrations, API/UI, then the v2
reconciler. Run the currently deployed status helper before the migration/API
mutations. After the API is live, use the new helper, which requires both
effective lane states and the authoritative `staging_state`. Do not deploy the
cumulative reconciler
until the migration and API are both live. Keep `RELEASE_BUS_V2_MODE=OFF`
throughout offline, shadow, staging beta, and production beta validation. The
status helpers must continue to report both lanes `OFF`; manual fallback remains
authoritative for everyone except the exact operator beta entries below.

The cumulative-staging migration has an intentionally non-destructive `down`:
rolling it back leaves its additive table and columns in place so older workers
cannot erase the authoritative admitted set. A genuine schema teardown requires
a separate destructive migration and is permitted only while v2 is confirmed
`OFF`.

The candidate-evidence policy is safe in that rolling order even when v2 is
already enabled. Its API writes new selections as
`READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION`; an older reconciler does not query
or claim that additive status. After runtime/ref parity confirms the new
reconciler is live, it claims the preserved selection under
`CANDIDATE_STAGING_EVIDENCE_V1`. Do not rewrite the status or fall back to the
legacy ready value during the rollout window.

### Operator-only OFF beta

`RELEASE_BUS_V2_BETA_ALLOWLIST` is a GitHub Actions variable containing a JSON
array. It is not a mode and never changes the helper result:

```json
[
  {
    "test_id": "backend-only-1",
    "candidate_id": "11111111-1111-4111-8111-111111111111",
    "repository": "backend",
    "branch_name": "agent/rb2-beta-backend-one",
    "operator": "exact-github-login",
    "lanes": ["STAGING"]
  }
]
```

The parser rejects unknown fields, duplicate candidate IDs, duplicate
repository/branch pairs, mixed operators/test IDs, invalid UUIDs, and unknown
lanes. An empty variable disables all beta automation. Invalid nonempty
configuration pauses `ALL` while mode remains `OFF`; OFF-mode manual fallback
continues to ignore v2 controls.

The infrastructure-retry case may add exactly one optional field to exactly
one entry:

```json
"inject_infrastructure_failure_operation": "PREPARE_ARTIFACT_BACKEND"
```

The value must match the entry's repository (`PREPARE_ARTIFACT_BACKEND` or
`PREPARE_ARTIFACT_FRONTEND`) and requires the `STAGING` lane. The reconciler
records `BETA_INFRASTRUCTURE_FAILURE_INJECTED`, places only that exact first
preflight attempt into `RETRY_WAIT` before dispatch, and dispatches attempt 2
after the normal bounded delay. It never applies in production or outside the
globally-OFF exact operator beta.

Before any allowlist is installed, exhaust local integration tests and
read-only shadow checks. Shadow checks may resolve exact refs, PR qualification,
current locks, and active workflow state, but must not update a shared ref,
dispatch a deploy/E2E workflow, or create/claim a live candidate. With the
allowlist absent, a worker invocation must claim and advance nothing.
The only permitted OFF/empty maintenance mutations are reconciling a stranded
internal `ADVANCE_MAIN_*` operation from a read-only exact `main` ref check,
releasing an environment lock already owned by a terminal train after every one
of that train's operations is terminal, and the operator-authenticated
`/deploy/release-bus-v2/maintenance/recover-stalled-qualifications` recovery.
Recovery is available in `OFF` with `ALL` paused or in `STAGING` with
`PRODUCTION` paused. It requires every v2 lock free, a double stable/idle
staging-ref handshake, and terminal parent/qualification operations. It then
owns the scheduler fence and transactionally locks/re-verifies all lock rows
before asserting that an unchanged repository actually mismatches the
qualification target. Each request yields at most one qualification and
returns `has_more=true` after every committed yield because that yield can
change another qualification's live yieldability. Invoke recovery again until
an empty response returns `has_more=false`; only that response proves the drain
pass is complete. The cleanup emits
`TERMINAL_INTERNAL_REF_OPERATION_RECONCILED` and
`TERMINAL_ENVIRONMENT_LOCK_RELEASED`; recovery emits
`PRODUCTION_QUALIFICATION_YIELDED` and
`PRODUCTION_TRAIN_YIELDED_FOR_SAFE_REPLAN`. An unknown ref identity retains the
lock. Cleanup cannot claim a candidate, advance a train, update a shared ref, or
dispatch a workflow.

For each single bounded staging test:

1. Prove both helpers report both lanes `OFF`, hidden fences are understood, no
   lock is owned, and no frontend/backend staging deploy, staging E2E, or
   shared-ref mutation is active. Never cancel or supersede unrelated work.
2. Install only that test's exact allowlist. Deploy the production API first
   and `releaseBus` second, both with v1/v2 modes still `OFF`; use explicit
   release-note opt-out for these internal operations.
3. Register only the preassigned synthetic IDs and exact branches. The
   reconciler snapshots both `1a-staging` refs and active workflows, acquires
   `staging-environment`, repeats the snapshot, and records
   `BETA_STAGING_IDLE_HANDSHAKE` before mutation. A busy workflow or changed ref
   releases the lock without mutation.
4. Run exactly one case to a terminal state. Record ready-to-deployed timing;
   report E2E separately. Verify transparent checks, exact artifacts/manifests,
   one build per artifact, and no duplicate workflow dispatch. Before a green
   E2E result may become `STAGING_VALIDATED`, re-check both staging refs and
   every staging deploy/E2E workflow created since the first pre-lock idle
   snapshot, ignoring only the train's exact workflow run IDs. Paginate the
   history and fail closed if its bounded scan cap is exhausted. Any unrelated
   active or completed mutation fails closed as a control-plane error, marks
   the mixed manifest failed, requeues rather than isolates candidates, pauses
   v2 automation, and releases staging ownership.
5. Clear the allowlist, deploy API then `releaseBus` with the empty value, and
   prove helpers still report both lanes `OFF`, the train is terminal, all related
   workflows are terminal, and the staging lock is free before the next case.

The required staging cases are backend-only, frontend-only, coupled backend
DAG/frontend, unrelated manual-work concurrency, and one injected
infrastructure failure with an idempotent retry. Backend ready-to-deployed must
be 3–5 minutes and frontend 10–15 minutes. Any reliability or timing miss keeps
the allowlist empty and automation globally `OFF` until repaired.

Production beta is a separate allowlist installation after all staging cases
pass. Use only exact `STAGING_VALIDATED` candidate IDs, list only the explicit
production subset, and require the operator's separate mark-ready action.
After general staging activation, global mode remains `STAGING`: a valid
production-only allowlist enables only those exact production candidates and
never filters, enrolls, or blocks ordinary staging candidates. Invalid beta
configuration pauses only `PRODUCTION`; staging automation and the manual
fallback remain available.
With exact validated candidates A/B/C, explicitly select dependency-closed A+C
and prove it claims directly under `CANDIDATE_STAGING_EVIDENCE_V1`, even when
A and C were validated in different trains/manifests. B must retain its exact
evidence and any separate production intent. Repeat with independent mixed
frontend/backend subsets while unrelated D/E staging work is active. The
production train may prepare concurrently, must never acquire
`staging-environment`, create `PRODUCTION_QUALIFICATION`, or enter
`WAITING_FOR_PRODUCTION_REPLAN`, and must not wait for, cancel, or interfere
with D/E. Any actual dependency on B/D/E must reject the omitted set unless the
required exact identity is already terminal in production.
Record overlapping train and operation run IDs, distinct environment-lock
ownership, evidence mappings, manifests, and timings; the scheduler lock must
be claim-only and brief rather than serializing either lane's workflows.
Before production mutation the reconciler performs the analogous double
active-workflow/main-ref snapshot under `production-environment` and records
`BETA_PRODUCTION_IDLE_HANDSHAKE`. Prove 3–5 minute backend or 10–15 minute
frontend promotion, exactly-once deployment and release-note finalization,
then clear/deploy the empty allowlist and return to idle.

General `STAGING` or `PRODUCTION` mode enablement is forbidden until every case
above passes and the owner explicitly authorizes cutover.

Rollback:

Run the account-guarded fast path from the backend repository:

```bash
node ops/scripts/release-bus-v2-fast-off.mjs --execute
```

It best-effort turns both automation lanes off, disables the reconciler
schedule, clears the
operator beta and sets both repository variables to `OFF`, updates production
API then reconciler with Lambda revision guards while preserving unrelated
environment values, and verifies both effective lanes `OFF`. Manual workflows
become available only after their drain gates. Every mutation is idempotent; if a
concurrent deploy or transient failure interrupts the command, run the same
command again until its final verification succeeds. The GitHub OFF source and
disabled schedule are intentionally retained after partial failure because
they are the safe direction, not compensated back to enabled automation.

1. clear the beta allowlist and use the internal hard stop so both effective
   lanes report `OFF`;
2. allow any already-dispatched exact operation to reach a safe terminal state;
3. verify no v2 train owns staging or production;
4. after each target drain gate, use the manual fallback, deploying dependent
   backend services in order while allowing known-independent staging services
   to run concurrently; the same service still queues and production remains
   globally serialized;
5. preserve v2 rows and immutable manifests for diagnosis.

Never cancel another actor's shared workflow or force-push a shared ref.
