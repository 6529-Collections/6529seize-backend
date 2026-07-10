# Script Agent Notes

These notes apply to files under `scripts/`.

## General Shell Script Rules

- Treat scripts as operational tooling. Check how a script is called before changing flags, defaults, paths, or exit behavior.
- Keep scripts portable for local macOS development unless a script already documents a narrower target.
- Do not hardcode secrets, staging hosts, AWS instance IDs, AWS profile names, local user paths, or machine-specific values.
- Prefer explicit validation before interpolating values into shell commands, SQL, JSON, or file paths.
- Keep retry, cleanup, and partial-output behavior intact unless the user explicitly asks to change it.
- Use clear log messages for long-running scripts so users can tell whether work is progressing or blocked.

## `sync-staging-db-local.sh`

This script is local development tooling that can replace the local Docker MySQL database. Do not run `--fresh`, restore, or other destructive modes without explicit user confirmation.

When editing it:

- Preserve resumability. Keep atomic `.tmp` writes, gzip validation, per-table completion markers, and schema drift invalidation behavior.
- Keep `--restore-only` independent of staging DB credentials and AWS credentials.
- Keep AWS access generic. The script should rely on the normal AWS CLI credential chain, including `~/.aws/credentials`, `AWS_PROFILE`, AWS SSO cached credentials, or environment variables. Do not require a specific "login" flow.
- Only use AWS when the automatic SSM tunnel is configured with `STAGING_SSM_TARGET`.
- Keep local DB credentials out of process arguments where practical.
- Validate table names, column names, chunk bounds, and numeric values before using them in SQL or filenames.
- Avoid adding row-count assumptions that would make resumable staging dumps fail just because staging changed during a long run. If stricter consistency is needed, document the trade-off first.

## Validation

For shell-only changes, use focused checks before broader CI:

```bash
bash -n scripts/sync-staging-db-local.sh
git diff --check
```

Run `shellcheck` when available. Do not introduce a dependency on it for normal local use unless the repo adds that dependency explicitly.
