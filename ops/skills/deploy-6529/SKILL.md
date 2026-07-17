---
name: deploy-6529
description: Determine the live 6529 Release Bus mode through authenticated gh, then route exact backend SHAs and allowlisted service DAGs through the required manual, shadow, staging-bus, production-bus, or operator break-glass path. Use when Codex is asked to stage, deploy, promote, merge for release, validate, pause, resume, recover, or coordinate a backend or combined frontend/backend release.
---

# Deploy 6529 Backend

Determine the live Release Bus mode before choosing either the bus or a manual
path. The frontend repository's
`ops/docs/developer/deployment-bus-process.md` is the lifecycle authority and
`deployment-bus-automation.md` is the operations runbook.

## Mandatory live preflight

Run this read-only helper from the repository root:

```bash
node ops/scripts/release-bus-status.mjs
```

Run it when a staging, production, promotion, merge-for-release, or deployment
request arrives; immediately before readiness submission; immediately before a
manual merge or workflow dispatch; and again before production after any
significant wait. Rerun whenever another actor could have changed rollout mode
or pause state.

The helper obtains the current developer token internally from authenticated
`gh`, queries the API, and prints only validated mode and pause states. Never
replace it with documentation, conversation history, an earlier check, GitHub
workflow configuration, AWS assumptions, repository files, or a signed-in
browser session. Never fall back to AWS CLI for mode discovery.

Fail closed. If `gh` is missing, require installation. If `gh` is
unauthenticated, require `gh auth login`. If the API is unavailable,
unauthorized, malformed, or returns an unknown state, stop before readiness,
merge, or deployment mutation and wait for the status check to succeed. Never
interpret uncertainty as `OFF` or as an enabled bus.

If `ALL` or the target lane is `PAUSED`, stop and report the paused scope. Do
not submit readiness or start a manual deployment unless an authorized
operator deliberately follows the audited break-glass procedure.

## Mode routing

| Live mode    | Staging behavior                                                 | Production behavior                                                         |
| ------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `OFF`        | Use the legacy manual path; do not queue in the bus              | Use the legacy manual path                                                  |
| `SHADOW`     | Record the candidate for shadow evaluation, then deploy manually | Record shadow evidence as designed, then deploy manually                    |
| `STAGING`    | Submit through the Release Bus and wait for validation           | Follow the operator/manual production path; do not queue a production train |
| `PRODUCTION` | Submit through the Release Bus                                   | Submit the staging-validated SHA through the Release Bus                    |

After an active bus lane accepts a candidate, never launch a parallel manual
deployment because the lane appears slow.

## Manual-route enforcement gate

For every repository affected by a manual route, inspect its live Actions
variable with authenticated `gh`:

```bash
gh variable list --repo 6529-Collections/6529seize-backend --json name,value
gh variable list --repo 6529-Collections/6529seize-frontend --json name,value
```

Use only the repositories in the release set. A successful listing with no
`RELEASE_BUS_ENFORCEMENT` entry means disabled; exact `false` also means
disabled, and exact `true` means enabled. Stop on command failure or any other
non-empty value. `OFF` or `SHADOW` with enforcement enabled is a configuration
mismatch: alert an operator and do not deploy. If the selected manual route is
enforced, verify that the authenticated user is an organization owner or an
active `release-bus-operators` member, require a non-empty audited reason, and
use the documented break-glass input. Never bypass a blocked workflow.

## Authority

- Treat a request to stage a development as authority to execute the live
  mode's staging route for its exact SHA.
- Treat a request to ship an exact staging-validated candidate as authority to
  execute the live mode's production route. An active bus needs no later human
  approval on its normal successful path.
- Do not manually dispatch `deploy.yml`, move `1a-staging`, or merge the source
  PR when the selected route belongs to an active bus lane unless an operator
  explicitly uses break glass.
- Never merge `1a-staging` into `main`.
- Do not invoke personal phase skills or publish release notes. The independent
  release-note service consumes successful production deployment signals.

## Bus readiness path

1. Open `/deploy/ui/bus`, choose `backend`, enter the branch, and resolve its
   current 40-character head SHA.
2. List all required candidate dependencies. Backend candidates may depend on
   other backend candidates, but must not require frontend-first deployment.
3. Select only committed service names from `src/config/deploy-services.json`.
4. Declare ordering edges such as `dbMigrationsLoop -> api`. Never put shell
   commands, regions, function names, or credentials in readiness metadata.
5. Submit staging readiness and monitor until the exact SHA is
   `STAGING_VALIDATED`.
6. Submit production readiness separately only while the branch still has the
   same head.

The registry supplies allowed environments, deploy adapter, regions,
verification targets, default dependencies, validation policy, and rollback
capability. The candidate supplies only unit names and extra ordering edges.

## Service order and zero downtime

- Deploy additive migrations before writers/readers that require them.
- Deploy backward-compatible API/backend behavior before dependent frontend
  behavior.
- Keep old request and response behavior usable through the compatibility
  window whenever possible.
- Use the service DAG for migrations, producers, consumers, API, and loops.
- A backend change that truly requires frontend first must be redesigned; the
  bus rejects that ordering.

The bus packages the exact train SHA once, verifies checksums and operation
authorization, deploys one backend unit at a time, and verifies every configured
Lambda/API target before advancing.

## Failure handling

- Fix a quarantined source branch and mark its new SHA ready again. Do not
  mutate the old candidate.
- Treat read-only Codex output, when enabled, as diagnostic context only.
  Deterministic checks decide quarantine. Without Codex, a merge-conflicting
  candidate is quarantined and unrelated candidates return to the queue
  automatically.
- If backend staging fails, frontend staging does not start.
- If backend production fails, frontend `main` is not advanced.
- Once production mutation starts, do not eject candidates. The production
  lane pauses for validated rollback or fix-forward recovery.
- Automatic rollback is permitted only when the service registry explicitly
  declares a tested rollback adapter. Unknown services remain paused for an
  operator.

## Operator break glass

Members of `release-bus-operators` and organization owners may:

1. Pause the affected scope at `/deploy/ui/bus` with a reason.
2. Wait for any mutating operation to become terminal.
3. Use `/deploy/ui` or `deploy.yml` with a non-empty break-glass reason.
4. Deploy one verified service/ref at a time in dependency order.
5. Validate Lambda code hashes, API version/health, logs, and changed behavior.
6. Repair or reconcile bus state and resume explicitly.

The workflow authorization endpoint rejects non-operators and active-train
overlap. Never bypass it by dispatching with fabricated release-bus inputs.

## Closeout

Report exact candidate SHA, service DAG, train status, workflow runs, deployed
version/hash evidence, dependent frontend status, and any pause or recovery.
Do not manually publish a release note.
