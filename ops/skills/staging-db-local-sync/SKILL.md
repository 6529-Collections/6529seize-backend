---
name: staging-db-local-sync
description: Use when syncing, restoring, documenting, or debugging the 6529 backend local database from staging via scripts/sync-staging-db-local.sh, including AWS SSM tunnel setup, local Docker MySQL restore, restart recovery, and staging DB env configuration.
---

# Staging DB Local Sync

Use this skill when the task involves the staging-to-local database sync script.

## First Read

Before changing behavior or giving detailed instructions, read:

1. `scripts/sync-staging-db-local.sh`
2. `docs/staging-db-local-sync.md`
3. `scripts/AGENTS.md`
4. `package.json` scripts for `db:staging:*`

If the user asks about their local env file, inspect only variable names and structure. Do not print secrets.

## Safety

- Do not run `--fresh`, restore, or any command that can replace the local database unless the user explicitly confirms.
- Treat `.env.staging-db.local` as trusted local shell config. Do not source unknown files without user approval.
- Do not commit local dump files, local env files, AWS credentials, profile names that are personal to one machine, instance IDs copied from private context, or local machine paths.
- Keep `--restore-only` usable without staging credentials and without AWS credentials.

## AWS Credentials

The script uses the normal AWS CLI credential chain.

Valid credential sources include:

- `~/.aws/credentials`
- `AWS_PROFILE`
- AWS SSO cached credentials
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`

Do not tell users they must run "aws login" in general. Say `aws sso login --profile <profile>` only when they use an SSO profile and the SSO cache is expired.

The script only calls AWS when `STAGING_SSM_TARGET` is set. Without that variable, it expects the configured staging host and port to already be reachable.

## Common Commands

Resume or start the normal sync:

```bash
npm run db:staging:resume
```

Archive the old dump and build a new one:

```bash
npm run db:staging:fresh
```

Dump only:

```bash
bash scripts/sync-staging-db-local.sh --dump-only
```

Restore only:

```bash
bash scripts/sync-staging-db-local.sh --restore-only --yes
```

## Debugging Checklist

When a run fails, check:

1. Is `.env.staging-db.local` present in the repo root?
2. Is Docker Desktop running, or is `AUTO_START_DOCKER=true`?
3. Is the local Docker MySQL service up?
4. If using SSM, are `aws` and `session-manager-plugin` installed?
5. If using SSM, can AWS CLI resolve valid credentials?
6. Does `.staging-db-dump/current/logs/ssm-tunnel.log` show a tunnel error?
7. Are staging read credentials valid?
8. Are local MySQL root credentials valid?

## Editing Guidance

- Preserve resumable dump behavior: atomic temp files, gzip validation, completion markers, and schema drift invalidation.
- Validate numeric chunk values and SQL identifiers before interpolation.
- Keep local DB passwords out of command-line arguments where practical.
- Keep docs aligned when changing flags, env vars, default values, or safety behavior.

## Validation

Use focused checks for shell or docs changes:

```bash
bash -n scripts/sync-staging-db-local.sh
git diff --check
```

Use broader repo validation when code paths outside docs or shell parsing change.
