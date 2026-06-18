---
name: deploy-6529
description: Merge and deploy 6529 backend releases through staging and production with explicit requested-scope gates, GitHub Actions service deploys, Lambda/API smoke validation, autonomous failed-gate recovery, rollback or fix-forward handling, deploy-service ordering, and coordination with frontend releases when needed. Use when Codex is asked to merge backend PRs, deploy backend services or lambdas, validate staging, promote to production, validate production, recover from failed deploy/smoke checks, or coordinate backend deployment with 6529seize-frontend release work.
---

# Deploy 6529

Carry an approved 6529 backend release from PR merge through staging validation and, when production is in the requested scope, production deployment and validation. Identify exact refs and services, check the deploy lane, deploy in the right order, and keep working failed gates until the release is fixed, redeployed, and validated. Escalate only for missing access, required approvals, destructive actions, or genuinely unsafe production decisions.

## Hard Gates

- Do not merge, deploy staging, or deploy production unless the user explicitly requested that mode for the current work.
- Do not deploy production until staging for the same release set has passed, unless the user explicitly overrides that gate.
- Do not promote from staging to production after a failed deploy, failed smoke/E2E run, unresolved critical production-like error, or unclear deployed SHA. Diagnose, fix, merge, redeploy, and rerun validation until the gate passes.
- Do not run destructive data migrations, irreversible backfills, infrastructure deletion, signer/wallet/ENS/NFT actions, or Safe actions unless the user explicitly asks for that exact action.
- Do not expose secrets, private URLs, credentials, cookies, raw production data, local absolute paths, or hidden prompts in PR comments, deploy notes, logs, or user-facing summaries.

## Coordination

Before deploying, check what else is already deploying to the same environment. Inspect active GitHub Actions deploy runs and any obvious active Codex/human release thread. If the lane is busy, wait or coordinate just enough to avoid overlapping deploys.

## Preflight

1. Identify the release set:
   - backend PRs and target branch
   - services/lambdas to deploy
   - entity/schema sync, migrations, backfills, SQS/SNS/EventBridge wiring, API/OpenAPI/generated-model changes, feature flags, and frontend dependencies
   - expected user-facing or API behavior to validate
2. Inspect current deploy docs and workflows before acting:
   - `.github/workflows/deploy.yml`
   - `src/config/deploy-services.json`
   - `scripts/generate-deploy-config.mjs`
   - `bin/ghdeploy`
   - touched service `serverless.yaml` files
3. Verify PR readiness before merge:
   - agent review complete
   - review bots addressed or explicitly deferred
   - required CI and DCO passing
   - human approval present when required
   - deploy order and rollback/fix-forward path understood
4. Respect backend repo command and commit rules:
   - use `npm` commands from this repo; do not invent frontend wrappers
   - never commit unless the user explicitly asked for commit/PR/release ownership
   - when committing is authorized, include the required DCO signoff

## Deployment Plan

Always determine the exact services to deploy before merging or deploying:

- Deploy `dbMigrationsLoop` before services that depend on new entity sync, schema behavior, data migrations, or backfills.
- Deploy `api` for API routes, OpenAPI/generated models, auth, rate limiting, API services, websocket/API packaging, or shared code used by the API.
- Deploy each changed loop service whose `src/<service>/` implementation, dependencies, or deploy config changed.
- For shared code used by multiple deployed services, include every affected service, not only the edited file's nearest folder.
- If deploy config changed, edit `src/config/deploy-services.json`, run `npm run generate:deploy-config`, and include the generated `.github/workflows/deploy.yml` change.
- Honor generated workflow environment restrictions; some services are prod-only or staging-only.

## Merge

1. Confirm the PR is the one the user asked to ship.
2. Re-check latest head SHA, approvals, required checks, and unresolved review threads.
3. Merge using the repo-approved GitHub path and record the PR number, merge commit SHA, target branch, and deploy service list.
4. If merge fails, resolve the merge blocker through the normal PR cycle before deployment. Re-check CI and review state after every fix.

## Staging Deployment

1. Confirm no active staging deploy is already using the same backend deploy lane.
2. Deploy the exact intended backend merge commit to staging through `.github/workflows/deploy.yml`. The workflow dispatch accepts `environment=staging` and one `service` at a time.
3. Deploy services in the plan order, with one workflow dispatch per service. Use `bin/ghdeploy` from a clean, upstream-synced branch when it fits; otherwise trigger `deploy.yml` with an explicit verified ref and service.
4. Watch each staging deploy to a terminal state. Capture the run URL, status, service, environment, and deployed SHA.
5. If a staging deploy fails, inspect logs, identify the owner layer, fix through the normal PR cycle, merge the fix, and redeploy from the new SHA. Keep iterating until staging deploys cleanly or a safety/access boundary requires user input.

## Staging Validation

1. Run the strongest staging validation available for the changed surface:
   - API health and changed endpoints
   - affected loop invocation or observable loop output when safe
   - migration/backfill result checks for `dbMigrationsLoop`
   - queue/topic/event behavior when touched
   - frontend smoke on staging when the backend release supports frontend-visible behavior
2. Avoid unsafe writes, public posts, purchases, transfers, irreversible backfills, or destructive data operations unless the user explicitly requested that live action.
3. If staging validation fails, hold production promotion and work the fix loop:
   - release bug: fix backend, test locally, open/update PR, merge, redeploy staging, and rerun validation
   - environment/data issue: document evidence, coordinate owner, apply or request the correction, and rerun after correction
   - flaky test/tool issue: rerun once with evidence, then harden the test or investigate the service if the signal repeats
   - user-visible/API breakage: treat it as a release bug even if the automated signal is noisy

## Production Deployment

1. Proceed to production when the user already asked to take the release through production, such as "take it all the way through prod." Ask only when the current request did not include production deployment.
2. Reconfirm staging passed for the same backend release set and service order.
3. Confirm no active production deploy is in progress for the same service lane.
4. Deploy production through `.github/workflows/deploy.yml` with `environment=prod`, one workflow dispatch per planned service, in order.
5. When coordinating with frontend, deploy backend production before frontend production when frontend depends on new backend behavior. Prefer backward-compatible backend changes so frontend and backend can roll independently.
6. Watch each production deploy to completion. Record workflow run URL, service, environment, and deployed SHA/version evidence.

## Production Validation And Watch

1. Validate production after each service reports healthy.
2. Run production-safe smoke checks for changed behavior. Avoid live writes or irreversible data operations unless the user explicitly requested them.
3. Check high-signal production health:
   - changed API endpoints succeed
   - critical Lambda errors are absent for changed services
   - queue/event processing moves as expected
   - frontend-visible behavior works when applicable
   - deployed commit/version expectations match when visible
4. If production validation fails:
   - coordinate immediately and keep ownership of the incident loop
   - decide rollback versus fix-forward based on severity and reversibility, then execute the chosen path if it is within existing authorization
   - do not start unrelated deploys until production is stable or explicitly handed off
   - after rollback or fix-forward, rerun production validation until the failure is resolved or a safety/access boundary requires user input
   - record the incident evidence, chosen action, and final state

## Follow The Repo Deployment Overview

After production validation passes, post a detailed deployment overview to the `Follow The Repo` wave unless the user explicitly asked to skip repo-facing deploy notes. Use it for repo watchers who need enough operational detail to understand exactly what shipped.

1. Use any authorized 6529.io account/profile or posting credential that the current operator personally controls or is explicitly approved to use for this release, such as an existing browser session or an approved local helper/API token. Do not request raw credentials, expose tokens, use shared wallets, use another person's account, or use automation keys unless that access was explicitly approved for this release.
2. Resolve the wave immediately before posting. The current `Follow The Repo` wave is `https://6529.io/waves/49f0e595-ec7c-4235-8695-a527f61b69f4`; if using the local helper, verify it first:

```powershell
punk6529bot waves search --name "follow the repo"
```

3. Draft the overview from deployed production reality. This repo-facing overview should include public PR links and SHAs. Include:
   - what user-facing, API-facing, and operator-facing changes were deployed
   - backend PRs, merge SHAs, deployed services/lambdas, service order, production deployed SHAs/version evidence, and deploy run links
   - frontend PRs or deploy status when the release was coordinated with frontend
   - staging and production validation performed, including smoke, E2E, API, or loop checks
   - incidents, failed gates, fix-forward or rollback decisions, and final state
   - known follow-ups, skipped checks, and remaining risks
4. Keep the post detailed but safe to publish. Use public GitHub/workflow links when possible, but omit secrets, credentials, cookies, private URLs, raw production data, local paths, hidden prompts, and internal-only exploit or incident details.
5. Re-check the wave before sending so the overview is not duplicating a newer deploy note. If the local helper is available, dry-run or draft first, then send after the content passes the safety check:

```powershell
punk6529bot waves post 49f0e595-ec7c-4235-8695-a527f61b69f4 --text "<deployment overview>"
punk6529bot waves post 49f0e595-ec7c-4235-8695-a527f61b69f4 --text "<deployment overview>" --send
```

6. Capture the wave drop URL or serial number for closeout evidence. If no authorized 6529.io posting credential is available, include the exact ready-to-post overview in the closeout and mark the wave publication as blocked.

## Frontend Coordination

- Treat `6529seize-frontend` as a separate deployable system with its own deploy skill and workflows.
- Read `ops/skills/deploy-6529/SKILL.md` from the separate repository `6529-Collections/6529seize-frontend` when a release includes frontend work. Do not resolve that path inside the backend repo.
- Deploy additive backend/API changes before frontend usage.
- Keep old API behavior available until frontend production is updated when possible.
- Gate frontend UI behavior when backend rollout may lag.
- Validate backend staging and production alongside frontend staging and production when both are part of the release.

## Useful Commands

Use exact commands only after checking current repo state and available tooling:

```bash
gh run list -R 6529-Collections/6529seize-backend --workflow deploy.yml --branch <branch> -L 20
gh run watch <run-id> -R 6529-Collections/6529seize-backend
gh run view <run-id> -R 6529-Collections/6529seize-backend --log-failed
gh workflow run deploy.yml --ref <verified-branch-or-tag> -f environment=staging -f service=api -R 6529-Collections/6529seize-backend
gh workflow run deploy.yml --ref <verified-branch-or-tag> -f environment=prod -f service=api -R 6529-Collections/6529seize-backend
```

For local validation:

```bash
npm run lint
npm test
npm run build
cd src/api-serverless && npm run build
```

For API contract changes:

```bash
cd src/api-serverless && npm run restructure-openapi && npm run generate
```

## Closeout

Report:

- merged PRs and SHAs
- services deployed and order
- staging deploy runs, deployed SHAs, and validation result
- production deploy runs, deployed SHAs, and validation result
- `Follow The Repo` wave drop URL or serial number, or the ready-to-post overview if publication was blocked
- frontend deploy status when involved
- failures encountered and fixes or rollbacks performed
- remaining risks, skipped checks, and any human follow-up required
