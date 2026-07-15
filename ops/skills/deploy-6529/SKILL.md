---
name: deploy-6529
description: Mark exact 6529 backend branch SHAs and allowlisted service DAGs ready for automated staging or production through the Release Bus, inspect train evidence, and handle operator break glass or backend deployment recovery. Use when Codex is asked to stage, deploy, promote, validate, pause, resume, recover, or coordinate a backend or combined frontend/backend release.
---

# Deploy 6529 Backend

Use the Release Bus as the normal release path. The frontend repository's
`ops/docs/developer/deployment-bus-process.md` is the lifecycle authority and
`deployment-bus-automation.md` is the operations runbook.

## Authority

- A request to stage a development authorizes marking its exact SHA ready for
  `STAGING`; it does not require or authorize a manual `1a-staging` merge.
- A request to ship an exact staging-validated candidate authorizes separate
  `PRODUCTION` readiness. The bus needs no later human approval on its normal
  successful path.
- Do not manually dispatch `deploy.yml`, move `1a-staging`, or merge the source
  PR while the bus is enabled unless an operator explicitly uses break glass.
- Never merge `1a-staging` into `main`.
- Do not invoke personal phase skills or publish release notes. The independent
  release-note service consumes successful production deployment signals.

## Mark ready

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
- Treat read-only Codex output as diagnostic context only. Deterministic checks
  decide quarantine.
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
