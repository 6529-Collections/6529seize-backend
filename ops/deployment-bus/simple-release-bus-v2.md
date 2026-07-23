# Simple Release Bus v2

Simple Release Bus v2 is the deployment authority for exact frontend/backend
candidate SHAs when its live mode enables a lane. Release Bus v1 stays disabled
as rollback reference.

## Route every request from live state

Run:

```bash
node ops/scripts/release-bus-status.mjs
```

The helper prefers `/deploy/release-bus-v2/controls` and temporarily falls back
to the v1 endpoint only before the additive v2 API exists.

| Mode | Staging | Production |
| --- | --- | --- |
| `OFF` | Serialized legacy manual route | Serialized manual route with explicit owner authority; no staging evidence gate |
| `STAGING` | V2 readiness | Production remains manual/disabled |
| `PRODUCTION` | V2 readiness | Separate explicit v2 action for an exact `STAGING_VALIDATED` candidate |

For an active mode, `ALL` and the target lane must be running. In `OFF`, v2
controls are non-authoritative and the manual fallback remains available when
`RELEASE_BUS_ENFORCEMENT` is absent or `false`, including owner-authorized
production without prior staging evidence.

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

1. The scheduler claims a dependency-closed set with zero fixed batch delay.
2. Frontend/backend composition and preparation run concurrently.
3. A single exact PR merge-tree artifact is reused when eligible. Otherwise,
   each application runs one combined sharded preflight and one immutable build.
4. Preparation may finish while another train owns staging.
5. The train acquires the staging lock only for deployment plus E2E.
6. Independent backend DAG frontier units deploy concurrently; dependency edges
   serialize only required units. Dependent frontend deploys after backend.
7. The controller persists `STAGING_DEPLOYED` with exact SHAs, artifact
   digests, services, operation runs, and timings.
8. E2E receives and authorizes against that manifest identity. Staging remains
   locked until E2E is terminal.
9. Only E2E success produces `STAGING_VALIDATED`.

`STAGING_DEPLOYED` and `STAGING_VALIDATED` are separate milestones.

## Production lifecycle

Staging validation never creates production readiness. A developer explicitly
marks the unchanged exact candidate SHA ready through the Deploy UI or the
versioned mark-ready endpoint.

Production selects only explicit candidates. It composes the proposed subset
from current `main`:

- if both exact composed tree SHAs match a validated manifest, reuse its
  validation and immutable artifacts;
- otherwise enqueue an exact `PRODUCTION_QUALIFICATION` staging train, run
  manifest-bound E2E, then continue automatically;
- immediately before mutation, require every `main` ref to equal its recorded
  base. A moved ref cancels and requeues the set for fresh qualification;
- advance exact tested commits, deploy the same artifacts in dependency order,
  verify exact versions, run production-safe read-only E2E, and mark
  `PRODUCTION_DEPLOYED`.

V2 never authors or posts release notes itself. Production operations must feed
the existing autonomous release-note bot complete, canonical grouping metadata
and an idempotent finalize signal. Internal operational candidates may opt out
explicitly.

## Failure behavior

| Class | Behavior |
| --- | --- |
| Candidate merge/test | Mark the direct candidate `NEEDS_REBASE` or failed; hold only transitive dependants |
| Infrastructure | Bounded idempotent retry; no candidate isolation |
| Retryable deployment | Retry only the failed operation; preserve successful sibling evidence |
| Control plane | Fail the train, requeue candidates, pause automated claiming, retain manual fallback |
| E2E | Keep the manifest unvalidated; do not globally pause unless state is unverifiable |

Every pending GitHub status must map to a visible candidate/train/operation state
and recovery message. Duplicate callbacks and worker invocations reuse immutable
operation identities and never repeat completed mutations.

## Operator rollout and rollback

Deploy additive changes in this order: database migrations, API/UI, then the v2
reconciler. Keep `RELEASE_BUS_V2_MODE=OFF` throughout offline, shadow, staging
beta, and production beta validation. The status helpers must continue to
report `OFF`; manual fallback remains authoritative for everyone except the
exact operator beta entries below.

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
   one build per artifact, and no duplicate workflow dispatch.
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
production subset, and require the operator's separate mark-ready action. The
first production beta must reuse exact qualification; if a qualification train
appears, stop with mode `OFF` and do not mutate staging. Before production
mutation the reconciler performs the analogous double active-workflow/main-ref
snapshot under `production-environment` and records
`BETA_PRODUCTION_IDLE_HANDSHAKE`. Prove 3–5 minute backend or 10–15 minute
frontend promotion, then clear/deploy the empty allowlist and return to idle.

General `STAGING` or `PRODUCTION` mode enablement is forbidden until every case
above passes and the owner explicitly authorizes cutover.

Rollback:

1. clear the beta allowlist, pause v2 `ALL` if state is uncertain, and keep mode
   `OFF`;
2. allow any already-dispatched exact operation to reach a safe terminal state;
3. verify no v2 train owns staging or production;
4. use the serialized manual fallback, dispatching backend `Deploy a service`
   workflows one at a time because shared concurrency can cancel sibling runs;
5. preserve v2 rows and v1 code for diagnosis—do not destructively delete them.

Never cancel another actor's shared workflow or force-push a shared ref.
