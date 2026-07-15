---
name: deploy-6529
description: Mark exact 6529 backend branch SHAs and allowlisted service DAGs ready for automated staging or production through the Release Bus, inspect train evidence, and handle operator break glass or backend deployment recovery. Use when Codex is asked to stage, deploy, promote, validate, pause, resume, recover, or coordinate a backend or combined frontend/backend release.
---

# Deploy 6529 Backend

Use `/deploy/ui/bus` as the normal release control plane.

## Normal path

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
