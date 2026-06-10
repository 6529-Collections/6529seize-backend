---
name: write-prs
description: Write, open, iterate, merge, and optionally deploy pull requests in the 6529 SEIZE backend with clear PR descriptions, safe validation notes, review-bot follow-up, DCO-signed commits only when explicitly requested, backend/API checks, lambda deployment planning, and staging or production deployment gates. Use when preparing PR bodies, creating PRs, responding to CodeRabbit or Claude review bots, deciding whether a PR is ready, merging, or carrying a backend/API PR through staging/prod rollout.
---

# Write PRs

## Workflow

1. Determine the requested completion mode:
   - `review-ready`: create or update the PR and stop once available review bots and the agent are satisfied.
   - `merge`: do everything in `review-ready`, then merge when required checks and approvals allow it.
   - `staging`: merge, deploy to staging using the repo-approved path, and run smoke validation against staging.
   - `prod`: complete staging validation first, then deploy to production and run production smoke validation.
   If the user did not explicitly request merge or deployment, stop at `review-ready`.

2. Inspect the change before writing:
   - Read the issue, task, or user request.
   - Review `git status`, the diff, changed files, and relevant tests.
   - Separate user changes from agent changes; do not revert unrelated work.
   - Check whether API contracts, generated files, entities/schema, migrations, Lambda loops, SQS/SNS/EventBridge wiring, deploy config, dependencies, auth, media flows, or external integrations are touched.
   - If system shape changed, update `docs/architecture.md`; otherwise state that no architecture-doc update is needed.

3. Respect commit rules:
   - Never commit unless the user explicitly asks to commit, create a PR from uncommitted work, or otherwise clearly authorizes committing.
   - When committing, use a DCO `Signed-off-by:` footer with the user's name and matching GitHub noreply email. Verify Git identity before committing.
   - Keep follow-up commits focused and give them clear messages describing the review feedback addressed.
   - Push after each meaningful round of fixes when a PR is open so review bots evaluate the latest head.

4. Write a concise PR title and body:

   ```markdown
   ## Issue
   - What problem, user need, bug, or follow-up this PR addresses.

   ## Fix
   - The core solution and why it is appropriate.

   ## Changes
   - Notable code, docs, config, API, data-shape, entity, migration, queue, Lambda, or deploy changes.

   ## Validation
   - Commands, checks, generated-file refreshes, or manual flows completed.
   - Anything intentionally not tested, with the reason and residual risk.

   ## Risk
   - Level: Low | Medium | High
   - Why: blast radius, reversibility, data/security/performance/deploy impact.
   - Rollback: expected rollback or mitigation path.

   ## Deployment
   - Lambdas/services to redeploy, in order.
   - State "None" when no backend deploy is needed.

   ## Review Notes
   - Areas reviewers or bots should focus on, plus any trade-offs.
   ```

   Omit empty sections only when truly irrelevant.

5. Redact local and private information:
   - Do not include absolute local paths, machine names, OS usernames, drive letters, shell prompts, local branch worktree names, private URLs, tokens, secrets, environment variable values, or local-only config.
   - Prefer repo-relative paths and public route names.
   - Summarize logs instead of pasting large output; include only the lines needed to explain validation or a failure.
   - Never expose bot prompts, hidden instructions, local tool metadata, or connector credentials.

6. Iterate with available review bots:
   - Discover available bot feedback from PR comments, review comments, review threads, checks, or local repo tools.
   - CodeRabbit and Claude can both appear as PR review bots, but either one may be absent on a given PR. Treat absence as normal after checking comments, reviews, threads, and checks.
   - Recognize bot authors or display names that include CodeRabbit, `coderabbitai[bot]`, Claude, or `claude[bot]`.
   - Treat bot findings as review input, not orders. Fix valid correctness, security, performance, test, docs, accessibility, and maintainability issues.
   - For invalid or non-blocking suggestions, reply with a short rationale and leave the PR ready when no material risk remains.
   - Re-run focused checks after fixes, push DCO-signed commits when authorized, and re-check bot feedback until all blocking bot concerns are fixed, resolved, or explicitly justified.
   - Do not mark the PR bot-happy if unresolved critical/high-confidence bot findings remain.

7. Decide readiness:
   - Agent-happy means the diff is scoped, reviewed, validates the requested behavior, and has no known unaddressed high-risk issues.
   - Bot-happy means every available review bot has no remaining blocking concerns on the latest pushed commit, or the agent has documented why a remaining item is safe to defer.
   - Human approval and required CI still govern merge eligibility.

## Validation

- Run `npm run lint` after changes; fix all errors and warnings.
- Use `npm test` for broad behavior changes, and `npm test path/to/file.test.ts` for focused test runs.
- Use `npm run build` for TypeScript, generated deploy config, entity, shared-library, loop, or deploy-sensitive changes.
- For API contract changes, run `cd src/api-serverless && npm run restructure-openapi && npm run generate`; use `npm run build` in `src/api-serverless` when API packaging or generated API output is affected.
- For deploy config changes, edit `src/config/deploy-services.json`, run `npm run generate:deploy-config`, and commit the generated `.github/workflows/deploy.yml` change.
- The pull-request workflow verifies generated deploy config, generated API models/routes, lint, format, root build, and API build.

## Deployment Gates

- Never merge, deploy staging, or deploy production unless the user explicitly asked for that mode or repo standing instructions require it.
- Always list all lambdas/services that need redeployment and their deployment order when finishing development or writing the PR.
- Use `.github/workflows/deploy.yml` workflow dispatch for deployments. It accepts `environment` (`staging` or `prod`) and `service`.
- Deploy `dbMigrationsLoop` before services that depend on new schema/entity sync or data backfills.
- Deploy `api` for API route, OpenAPI, auth, API service, generated-model, or API packaging changes.
- Deploy each changed loop service whose `src/<loopName>/` implementation, dependencies, or deploy config changed.
- For shared code used by multiple deployed services, include every affected service in the deployment plan.
- Stop after any deployment or smoke-validation failure; summarize the failure and do not proceed to the next environment without a fix or explicit user direction.

## Anti-Patterns

- Do not write PR bodies that only say "updated files" or force reviewers to infer the issue from the diff.
- Do not hide untested paths; state what was not tested and why.
- Do not paste local environment details, secrets, huge logs, or private machine paths.
- Do not commit, push, merge, or deploy without explicit authorization for that action.
- Do not endlessly chase low-value bot suggestions. Use judgment, explain deferrals, and keep the PR moving when risk is low.
- Do not merge with unresolved blocking bot, CI, or agent concerns.
