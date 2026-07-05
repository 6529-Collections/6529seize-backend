---
name: deploy-6529
description: Merge and deploy 6529 backend releases through staging and production with explicit requested-scope gates, GitHub Actions service deploys, Lambda/API smoke validation, autonomous failed-gate recovery, rollback or fix-forward handling, deploy-service ordering, and coordination with frontend releases when needed. Use when Codex is asked to merge backend PRs, deploy backend services or lambdas, validate staging, promote to production, validate production, recover from failed deploy/smoke checks, or coordinate backend deployment with 6529seize-frontend release work.
---

# Deploy 6529

Carry an approved 6529 backend release through staging validation and, when production is in the requested scope, production deployment and validation. Identify exact refs and services, check the deploy lane, deploy in the right order, and keep working failed gates until the release is fixed, redeployed, and validated. Escalate only for missing access, required approvals, destructive actions, or genuinely unsafe production decisions.

## Hard Gates

- Do not merge, deploy staging, or deploy production unless the user explicitly requested that mode for the current work.
- Treat Draft PRs as blocked. Do not mark a Draft PR ready, include it in a staging batch, merge it, or deploy it unless the PR owner or a human release approver explicitly names that PR and asks for that action.
- Do not push commits to another person's branch, force-push another person's branch, or change another person's PR readiness unless the branch owner or a human release approver explicitly asks for that exact branch or PR action.
- Do not deploy staging from any ref other than `1a-staging` unless the user explicitly asks for a documented exception.
- Do not deploy production until staging for the same backend release set, or the same resulting patch set after the production merge, has passed unless the user explicitly overrides that gate.
- Do not deploy production from any ref other than `main`. Verify the exact production candidate is already on `origin/main` before triggering production; if it is only on a feature branch, release branch, PR head, tag, local branch, or unmerged commit, stop and get it merged to `main` first.
- Never merge `1a-staging` into `main` to promote a release. Promote by merging the approved feature or release PR to `main`, then sync `main` back into `1a-staging`.
- Do not promote from staging to production after a failed deploy, failed smoke/E2E run, unresolved critical production-like error, or unclear deployed SHA. Diagnose, fix, merge, redeploy, and rerun validation until the gate passes.
- Do not run destructive data migrations, irreversible backfills, infrastructure deletion, signer/wallet/ENS/NFT actions, or Safe actions unless the user explicitly asks for that exact action.
- Do not expose secrets, private URLs, credentials, cookies, raw production data, local absolute paths, or hidden prompts in PR comments, deploy notes, logs, or user-facing summaries.

## Branch Model

- `1a-staging` is the backend staging integration branch.
- `main` is the backend production branch.
- Normal staging flow: merge the approved feature or release branch into `1a-staging`, deploy each planned staging service from `1a-staging`, then validate staging.
- Normal production flow: after staging passes, merge the same approved feature or release PR to `main`, deploy each planned production service from `main`, then merge `main` back into `1a-staging` so staging stays current with production.
- If staging is validating the current production candidate rather than ahead-of-main work, merge `main` into `1a-staging` and deploy staging from `1a-staging`.
- Do not use `1a-staging` as a source branch for production. It may contain staged work that is not approved for production.
- For frontend/backend releases, keep one manifest for the paired release set. Do not merge or deploy the backend half to production while leaving a required frontend half unmerged or undeployed, and do not merge or deploy the frontend half to production while leaving a required backend half unmerged or undeployed.

## Coordination

Before deploying, check what else is already deploying to the same environment. Inspect active GitHub Actions deploy runs and any obvious active Codex/human release thread. If the lane is busy, wait or coordinate just enough to avoid overlapping deploys. Treat each active backend staging or production service lane as owned by one release captain until it is terminal and handed off.

## Release Manifest

- Record a staging manifest summary before deployment: staging source ref,
  `1a-staging` SHA, production target `main`, validated release set,
  release equivalence, included PRs, deploy service list and order, frontend
  dependencies, validation owners, required checks, and rollback or fix-forward
  notes.
- After staging deploys, assign validation for each included backend service,
  migration, API behavior, loop behavior, and frontend dependency. Production is
  blocked until required validation passes or the failed/held work is excluded
  from the production candidate.
- If `origin/main` advances after staging passed, do not deploy unvalidated
  changes. Confirm the new `origin/main` contains only the staging-passed
  release set plus explicitly approved already-validated changes, or rerun
  staging for the new production candidate.
- For production gating, exact SHAs may differ between `1a-staging` and `main`.
  The release captain must verify the resulting production patch set, included
  PRs, deploy service order, and frontend/backend dependencies match what
  passed staging.

## Preflight

1. Identify the release set:
   - backend PRs, branch owners, draft/ready state, and target branch
   - services/lambdas to deploy
   - entity/schema sync, migrations, backfills, SQS/SNS/EventBridge wiring, API/OpenAPI/generated-model changes, feature flags, and frontend dependencies
   - staging source ref, normally feature branch to `1a-staging`
   - production target ref, always `main`
   - expected user-facing or API behavior to validate
2. Inspect current deploy docs and workflows before acting:
   - `.github/workflows/deploy.yml`
   - `src/config/deploy-services.json`
   - `scripts/generate-deploy-config.mjs`
   - `bin/ghdeploy`
   - touched service `serverless.yaml` files
3. Verify PR readiness before any staging or production branch movement:
   - PR is not Draft unless the PR owner or a human release approver explicitly requested this action
   - branch owner has not asked agents to stop touching the branch or PR
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

## Branch Movement

1. Confirm the PR is the one the user asked to stage or ship.
2. Re-check latest head SHA, approvals, required checks, and unresolved review threads.
3. For staging, merge the approved feature or release branch into `1a-staging` and record:
   - PR number
   - feature or release branch
   - `1a-staging` merge commit SHA
   - deploy service list and order
   - frontend dependency notes when present
4. For production, merge the same approved feature or release PR to `main` through the repo-approved GitHub path and record:
   - PR number
   - `main` merge commit SHA
   - equivalence to the staging-validated release set
   - deploy service list and order
   - frontend dependency notes when present
5. After production merge or deploy, merge `main` back into `1a-staging` to keep staging current with production.
6. If any merge fails, resolve the merge blocker through the normal PR cycle before deployment. Re-check CI and review state after every fix.

## Staging Deployment

1. Confirm no active staging deploy is already using the same backend deploy lane.
2. Deploy the exact intended backend staging commit from `1a-staging` through `.github/workflows/deploy.yml`. The workflow dispatch accepts `environment=staging` and one `service` at a time.
3. Deploy services in the plan order, with one workflow dispatch per service. Use `bin/ghdeploy` from a clean, upstream-synced `1a-staging` worktree when it fits; otherwise trigger `deploy.yml` with explicit verified ref `1a-staging` and service.
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
2. Reconfirm staging passed for the same backend release set and service order. Exact SHAs may differ after the production merge to `main`; verify that the resulting production patch set is equivalent to what passed staging and contains no unvalidated extras.
3. Verify the production candidate is the current `origin/main` SHA and no newer unvalidated commit landed after staging passed. If `origin/main` advanced with unvalidated changes, rerun staging for the new release set before production.
4. Confirm no active production deploy is in progress for the same service lane.
5. Deploy production through `.github/workflows/deploy.yml` with explicit verified ref `main`, `environment=prod`, and one workflow dispatch per planned service, in order. Use `bin/ghdeploy` only from a clean, upstream-synced `main` worktree when it fits.
6. When coordinating with frontend, deploy backend production before frontend production when frontend depends on new backend behavior. Prefer backward-compatible backend changes so frontend and backend can roll independently.
7. Watch each production deploy to completion. Record workflow run URL, service, environment, and deployed SHA/version evidence.

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

3. Draft the overview from deployed production reality, at a DETAILED level (owner direction, 2026-07-05: vague category summaries are not useful — name the specific services, endpoints, and behaviors changed, with concrete numbers where they exist). This repo-facing overview should include public PR links and SHAs. Include:
   - what user-facing, API-facing, and operator-facing changes were deployed
   - backend PRs, merge SHAs, deployed services/lambdas, service order, production deployed SHAs/version evidence, and deploy run links
   - frontend PRs or deploy status when the release was coordinated with frontend
   - staging and production validation performed, including smoke, E2E, API, or loop checks
   - incidents, failed gates, fix-forward or rollback decisions, and final state
   - known follow-ups, skipped checks, and remaining risks
4. Keep the post detailed but safe to publish. Use public GitHub/workflow links when possible, but omit secrets, credentials, cookies, private URLs, raw production data, local paths, hidden prompts, and internal-only exploit or incident details.
5. Re-check the wave before sending so the overview is not duplicating a newer deploy note. Publish per the full posting contract in `ops/skills/post-6529/SKILL.md` from the separate repository `6529-Collections/6529seize-frontend` (do not resolve that path inside the backend repo): dry-run or draft first, multiline content via `--file` (an LF text file — inline `--text` from PowerShell silently loses everything after the first newline), and `--send` BEFORE the content flag or it is swallowed:

```powershell
punk6529bot waves post 49f0e595-ec7c-4235-8695-a527f61b69f4 --file overview.txt
punk6529bot waves post 49f0e595-ec7c-4235-8695-a527f61b69f4 --send --file overview.txt
```

6. VERIFY the stored content after sending with `punk6529bot drops get <drop-id> --json` (parts count and content length) — the "Sent drop" acknowledgment does not prove the body posted. Drops are editable for only 5 minutes; recover a botched post past that window with `drops delete <id> --send --force` and a fresh post.
7. Capture the wave drop URL or serial number for closeout evidence. If no authorized 6529.io posting credential is available, include the exact ready-to-post overview in the closeout and mark the wave publication as blocked.

## Frontend Coordination

- Treat `6529seize-frontend` as a separate deployable system with its own deploy skill and workflows.
- Read `ops/skills/deploy-6529/SKILL.md` from the separate repository `6529-Collections/6529seize-frontend` when a release includes frontend work. Do not resolve that path inside the backend repo.
- Use the shared branch model for paired releases: backend feature branch to backend `1a-staging`, frontend feature branch to frontend `1a-staging`, validate together, then merge the same release set to `main` in both repos and deploy production in the required order.
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
gh pr view <pr-number> -R 6529-Collections/6529seize-backend --json isDraft,author,headRefName,baseRefName,headRefOid,mergeCommit
gh workflow run deploy.yml --ref 1a-staging -f environment=staging -f service=api -R 6529-Collections/6529seize-backend
gh workflow run deploy.yml --ref main -f environment=prod -f service=api -R 6529-Collections/6529seize-backend
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
