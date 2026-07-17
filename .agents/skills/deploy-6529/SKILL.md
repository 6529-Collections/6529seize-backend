---
name: deploy-6529
description: Determine the live 6529 Release Bus mode through authenticated gh, then route exact backend SHAs and allowlisted service DAGs through the required manual, shadow, staging-bus, production-bus, or operator break-glass path. Use when Codex is asked to stage, deploy, promote, merge for release, validate, pause, resume, recover, or coordinate a backend or combined frontend/backend release.
---

# Deploy 6529 Backend

Determine the live mode before choosing `/deploy/ui/bus` or the manual path.

## Mandatory live preflight

Run `node ops/scripts/release-bus-status.mjs` when a staging, production,
promotion, merge-for-release, or deployment request arrives; immediately before
readiness; immediately before a manual merge or workflow dispatch; and again
before production after a significant wait.

The helper obtains the token internally from authenticated `gh`. Do not infer
mode from docs, prior conversation, an earlier status, workflows, AWS,
repository files, or browser login, and never fall back to AWS CLI. If `gh` is
missing or unauthenticated, require installation or `gh auth login`. If the API
is unavailable, unauthorized, malformed, or unknown, stop before mutation.
Never treat uncertainty as `OFF` or as an enabled bus.

Stop when `ALL` or the target lane is `PAUSED` unless an authorized operator
deliberately follows audited break glass.

## Mode routing

| Live mode    | Staging behavior                                                 | Production behavior                                                         |
| ------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `OFF`        | Use the legacy manual path; do not queue in the bus              | Use the legacy manual path                                                  |
| `SHADOW`     | Record the candidate for shadow evaluation, then deploy manually | Record shadow evidence as designed, then deploy manually                    |
| `STAGING`    | Submit through the Release Bus and wait for validation           | Follow the operator/manual production path; do not queue a production train |
| `PRODUCTION` | Submit through the Release Bus                                   | Submit the staging-validated SHA through the Release Bus                    |

After an active lane accepts a candidate, never start a parallel manual deploy.

## Manual-route enforcement gate

For each affected repository, inspect `RELEASE_BUS_ENFORCEMENT` with
authenticated `gh variable list --repo 6529-Collections/<repository> --json
name,value`. A successful list with no entry or exact `false` means disabled;
exact `true` means enabled. Stop on command failure or another non-empty value.
`OFF` or `SHADOW` plus enabled enforcement is a configuration mismatch. If the
manual route is enforced, verify organization-owner or active
`release-bus-operators` membership and require a non-empty audited break-glass
reason. Never bypass a blocked workflow.

## Bus readiness path

1. Resolve the backend branch's exact head SHA.
2. Declare immutable frontend/backend candidate dependencies.
3. Select allowlisted service units from `src/config/deploy-services.json` and
   add only required ordering edges.
4. Mark the SHA ready for `STAGING`; do not merge or dispatch manually.
5. After exact-SHA staging validation, separately mark the same SHA ready for
   `PRODUCTION`.
6. Let the bus package and deploy backend units in DAG order before dependent
   frontend deployment.

A new branch head is a new candidate. Never silently move readiness. Backend
candidates must not depend on frontend-first deployment.

## Safety

- Prefer additive migrations and backward-compatible API behavior.
- Never merge `1a-staging` into `main`.
- Do not overlap bus or manual deployments.
- Do not fabricate release-bus workflow inputs or operation keys.
- Treat Codex as a conflict resolver on temporary branches or a read-only
  diagnostic, never as deploy/ejection authority.
- After production mutation begins, pause and use only declared rollback or a
  validated operator fix-forward.
- Do not publish release notes; the independent service owns them.

## Break glass

Only a `release-bus-operators` member or organization owner may pause the bus
and use `/deploy/ui` or `deploy.yml` with an audited reason. Wait for active
mutation to finish, deploy one verified unit at a time, validate health and
code hashes, reconcile state, and resume explicitly.

Report exact SHAs, service order, workflow/deployed evidence, and final bus
state.
