# Simple Release Bus v2

Simple Release Bus v2 is the deployment authority for exact frontend/backend
candidate SHAs when its live mode enables a lane.

## Route every request from live state

Run:

```bash
node ops/scripts/release-bus-status.mjs
```

The helper reads `/deploy/release-bus-v2/controls` and fails closed if the
versioned status is unavailable or malformed.

| Mode         | Staging                 | Production                                                                         |
| ------------ | ----------------------- | ---------------------------------------------------------------------------------- |
| `OFF`        | Serialized manual route | Serialized manual route with explicit owner authority; no staging evidence gate    |
| `STAGING`    | V2 readiness            | Manual/disabled by default; exact operator-only production beta may be allowlisted |
| `PRODUCTION` | V2 readiness            | Separate explicit v2 action for an exact `STAGING_VALIDATED` candidate             |

For an active mode, `ALL` and the target lane must be running. In `OFF`, v2
controls are non-authoritative and the manual fallback remains available,
including owner-authorized production without prior staging evidence.

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

1. The scheduler starts from the authoritative cumulative admitted-staging set,
   carries every unchanged exact live candidate forward, and adds a
   dependency-closed set of newly ready candidates with zero fixed batch
   delay. A later ordinary train cannot omit or evict an admitted candidate.
2. Frontend/backend composition and preparation run concurrently.
3. A single exact PR merge-tree artifact is reused when eligible. Otherwise,
   each application runs one combined sharded preflight and one immutable build.
4. Preparation may finish while another train owns staging.
5. The train acquires the staging lock only for deployment plus E2E.
   Under that lock it binds every unchanged repository to the exact current
   `1a-staging` ref, so a frontend-only or backend-only manifest describes the
   environment E2E actually sees rather than the unrelated `main` ref.
6. Independent backend DAG frontier units deploy concurrently; dependency edges
   serialize only required units. Dependent frontend deploys after backend.
7. The controller persists `STAGING_DEPLOYED` with exact SHAs, artifact
   digests, services, operation runs, and timings.
8. E2E receives and authorizes against that manifest identity. Staging remains
   locked until E2E is terminal.
9. Only E2E success produces `STAGING_VALIDATED`.

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
claim to the candidate's current selection ID and exact historical
staging train/manifest/E2E evidence, revalidates the unchanged branch head,
creates a new production-selection identity, and records the failed train as
the retry source. Any deploy, E2E, ref-mutation, unknown, or nonterminal
operation makes the failure ineligible for this path.

The selection must be transitively dependency-closed. A production-scoped
prerequisite must either be selected in the same action or already be terminal
`PRODUCTION_DEPLOYED` with a production manifest containing that exact
candidate/repository/PR/head identity and successful production E2E. Omitted
unrelated candidates keep their staging evidence and separate production
intent.

New production trains use `CANDIDATE_STAGING_EVIDENCE_V1`:

- resolve and persist, per selected candidate, candidate ID, repository, PR,
  head SHA, staging train, validated manifest identity, and the successful
  staging E2E operation/run;
- freshly compose both repositories against the current trusted `main` bases.
  Frontend and backend preparation may run concurrently. A candidate's old PR
  artifact or an exact combined staging artifact is never reused for ordinary
  production qualification;
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

| Class                         | Behavior                                                                                                                                                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate merge/test          | Before shared mutation, fail the cumulative train closed and leave the last validated admitted manifest live; mark only the new direct candidate `NEEDS_REBASE` as applicable                                                                                                     |
| Infrastructure                | Bounded idempotent retry; no candidate isolation                                                                                                                                                                                                                                  |
| Retryable deployment          | Retry only the failed operation; preserve successful sibling evidence                                                                                                                                                                                                             |
| Control plane                 | Fail the train, requeue candidates, pause automated claiming, release an environment lock once every operation is terminal, retain manual fallback                                                                                                                                |
| E2E                           | Keep the failed manifest unvalidated and restore/deploy/E2E the exact last validated live manifest under the same staging lock; commit no admission change until restoration validates                                                                                            |
| Production preflight          | Fail before shared mutation. A later explicit exact-SHA selection may retry only after the unchanged staging evidence is revalidated and the locked failed train contains only terminal compose/preflight operations; audit both selection identities and the failed source train |
| Production after main advance | Fail selected candidates closed, pause `PRODUCTION`, and block later production claims. `main` remains truthful and is never rewritten; an operator must prove the recorded exact main/runtime parity or complete an explicit rollback before resuming                            |

Every pending GitHub status must map to a visible candidate/train/operation state
and recovery message. Duplicate callbacks and worker invocations reuse immutable
operation identities and never repeat completed mutations.

## Operator rollout and rollback

Deploy additive changes in this order: database migrations, API/UI, then the v2
reconciler. Run the currently deployed status helper before the migration/API
mutations. After the API is live, use the new helper, which requires and shows
the authoritative `staging_state`. Do not deploy the cumulative reconciler
until the migration and API are both live. Keep `RELEASE_BUS_V2_MODE=OFF`
throughout offline, shadow, staging beta, and production beta validation. The
status helpers must continue to report `OFF`; manual fallback remains
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

1. Prove both helpers report `OFF`, controls are understood, no lock is owned,
   and no frontend/backend staging deploy, staging E2E, or shared-ref mutation
   is active. Never cancel or supersede unrelated work.
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
   prove helpers still report `OFF`, the train is terminal, all related
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

It best-effort pauses only v2, disables the reconciler schedule, clears the
operator beta and sets both repository variables to `OFF`, updates production
API then reconciler with Lambda revision guards while preserving unrelated
environment values, and verifies empty `OFF`. Manual workflows remain
available. Every mutation is idempotent; if a
concurrent deploy or transient failure interrupts the command, run the same
command again until its final verification succeeds. The GitHub OFF source and
disabled schedule are intentionally retained after partial failure because
they are the safe direction, not compensated back to enabled automation.

1. clear the beta allowlist, pause v2 `ALL` if state is uncertain, and keep mode
   `OFF`;
2. allow any already-dispatched exact operation to reach a safe terminal state;
3. verify no v2 train owns staging or production;
4. use the serialized manual fallback, dispatching backend `Deploy a service`
   workflows one at a time because shared concurrency can cancel sibling runs;
5. preserve v2 rows and immutable manifests for diagnosis.

Never cancel another actor's shared workflow or force-push a shared ref.
