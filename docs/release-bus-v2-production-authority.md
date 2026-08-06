# Release Bus v2 production authority

The production authority is the minimal control-plane lease for one frontend or
backend production operation. Both repositories use the same
`production-environment` lock and the same `PRODUCTION` control epoch; there is
no repository-local production lane.

## Contract

All routes require the existing `RELEASE_BUS_WORKFLOW_AUTH_TOKEN` bearer
credential. The credential authenticates the workflow/controller channel; the
request must still carry the exact operation identity.

The immutable prepare/bind identity is:

```json
{
  "operation_id": "frontend-prod-123",
  "controller_identity": "frontend-production-workflow",
  "repository": "frontend",
  "environment": "prod",
  "service": "frontend",
  "target_sha": "<40 lowercase hex characters>",
  "selection_digest": null
}
```

`controller_identity` is restricted to the approved frontend workflow, backend
workflow, or `deploy-hub`, with repository-specific combinations enforced.
`target_sha` must be reachable from that repository's protected `main` history.
The actor recorded on the bound deployment run must be an active member of the
configured `RELEASE_BUS_OPERATOR_TEAM` or an organization administrator. The
automated qualification run is not required to be an organization operator;
its authorization comes from its exact workflow path, repository, branch,
title, attempt, and terminal evidence.
The response contains the non-secret `operation_id`, state, lease expiry,
hard-expiry, control epoch, and lock row version. It never contains
`lease_token`.

The routes are:

| Route                                                           | Purpose                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /deploy/release-bus-v2/production-authority/prepare`      | Trusted external-controller reservation after authoritative drain. Creates short-lived `PREPARED` state with no workflow binding and no selection digest.                                                                                               |
| `POST /deploy/release-bus-v2/production-authority/acquire-bind` | GitHub first-job path. Independently verifies the exact in-progress deploy workflow run and atomically acquires the shared DB lock plus a `BOUND` authority. Use this when the run already exists.                                                      |
| `POST /deploy/release-bus-v2/production-authority/bind`         | Binds a pre-dispatch `PREPARED` row to the exact in-progress run after the same identity and drain checks.                                                                                                                                              |
| `POST /deploy/release-bus-v2/production-authority/reauthorize`  | Immediate pre-AWS check. Requires the exact deploy run/attempt, current control epoch, protected-main ancestry, live lease, and a lowercase 64-hex `selection_digest`; the first successful call freezes that digest. Later calls must match it.        |
| `POST /deploy/release-bus-v2/production-authority/complete`     | Releases success only when the original deployment is independently re-read as terminal success, the current control epoch still matches, and the selected digest, trusted completion run ID/attempt, and lowercase 64-hex evidence digest match.       |
| `POST /deploy/release-bus-v2/production-authority/fail`         | Releases a bound operation only from exact terminal GitHub failure evidence. Backend failures identify the bound `Deploy a service` run; frontend failures identify either the bound `Web Deploy - PROD` run or its exact automatic Production E2E run. |

Completion additionally requires:

```json
{
  "selection_digest": "<64 lowercase hex characters>",
  "qualifier_workflow_run_id": "202",
  "qualifier_workflow_run_attempt": 2,
  "evidence_digest": "<64 lowercase hex characters>"
}
```

For a frontend authority, the backend reads the qualifier run from the
frontend repository and requires the exact `workflow_dispatch` run identity:
head repository `6529-Collections/6529seize-frontend`, path
`.github/workflows/production-e2e.yml`, name `Production E2E`, and display title
`Production E2E automatic <deploy_workflow_run_id>` where the deploy ID is the
authority's persisted bound run. It also requires actor
`github-actions[bot]`, `main`, the requested attempt, `completed`, and
`success`; a human-dispatched, automatic-looking run is not accepted. Its head
SHA may be a later protected-main descendant because the workflow is dispatched
from current `main`. The workflow's resolver and immutable completion artifact,
represented by the evidence digest, prove the deployed target. The evidence
digest is the immutable digest emitted by that workflow after its isolated
verifier succeeds.

For a backend authority, the qualifier is the already-bound deployment run
itself: `qualifier_workflow_run_id` must equal the persisted deployment run ID
and its attempt must equal the persisted deployment attempt. The backend reads
that run from `6529-Collections/6529seize-backend` and requires completed
success, `workflow_dispatch`, `main`, head SHA equal to the authority target,
path `.github/workflows/deploy.yml`, workflow name `Deploy a service`, head
repository `6529-Collections/6529seize-backend`, and exact display title
`Deploy <service> to prod [<operation_id>]`. The evidence digest is still
required and immutable. In both cases the backend persists qualifier run,
attempt, and digest and rejects later changes.

Failure callbacks use the same terminal identity rules. An in-progress run, an
arbitrary run ID, a foreign repository, or a mismatched attempt cannot release
the lease. A frontend automatic E2E failure is accepted only after the bound
deployment has independently been shown to have completed successfully; the
E2E identity must also carry the exact bound title, automatic actor, and
protected-main identity. Its head SHA may be a later protected-main descendant,
with the original deployment run and immutable failure evidence binding the
deployed target. The failure evidence is persisted with the terminal record.

## State and invariants

`PREPARED` has a five-minute unbound lease. A bound lease renews for 130 minutes
at a time, up to a 150-minute hard TTL. The renewal exceeds the configured
22-minute deployment-readiness ceiling plus the 90-minute Production E2E timeout
by 18 minutes; the hard cap provides 38 minutes of absolute headroom over those
windows for queue/callback work. A successful deploy does not release the
authority; only exact E2E completion, owner failure, or expiry does.
Every renewal/reauthorization uses the exact
stored owner and DB token inside the service transaction. Completion/failure
releases the lock by that stored token and clears it from the authority row;
the token is never accepted as an API input and never crosses the GitHub job
boundary.

Before a run ID is passed to the active-workflow drain, the service reads and
independently verifies that run's path, name, event, branch, SHA, attempt, and
in-progress status. Only that verified run ID is ignored. A foreign or malformed
run is rejected before any ignore list is constructed. The database lock and
authority row are acquired/bound under one writer transaction; GitHub readback
is performed immediately before that transaction because GitHub cannot
participate in the MySQL transaction.

Denials are terminal and persist a bounded machine-readable `denial_code` plus
the observed `ALL`/`PRODUCTION`/mode epoch. Lane-on, control-epoch changes,
active trains/operations/workflows, lock contention, ancestry failure, lease
loss, qualifier identity failure, and evidence mismatch are fail-closed. The
caller must react to the denial; there is no timed blind retry contract.

The existing `/deploy/release-bus-v2/manual-deployment-readiness` route remains
unchanged for readiness evidence. During the API-only phase,
`dbMigrationsLoop` is deployed before `api`, while the tracked workflows still
call only `manual-deployment-readiness`. The manual-fallback race is resolved
only after the separate workflow consumers are deployed and every manual
production caller acquires this same authority lease. The API does not add a
second manual lease or accept a caller-supplied token. The route therefore
remains a readiness contract, not a substitute for the authority lease, and it
does not receive or expose the server-side token.

## Schema deployment

Roll out the API-only contract in this order: deploy `dbMigrationsLoop` first,
then deploy `api`, and only then enable or update workflow consumers. The
registered authority entity is synchronized by the normal TypeORM
entities-first path; there is intentionally no standalone migration file in
this rollout. Verify the table, unique operation key, and indexed status fields
on the writer database before deploying `api`. Before rollback, drain callers
and ensure no authority is active; retain the authority table as audit history
rather than dropping it. Frontend and workflow-generated clients must be
regenerated and checked as a later consumer step against the published
OpenAPI contract.
