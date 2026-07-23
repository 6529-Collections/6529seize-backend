# Staging DB Local Sync

`scripts/sync-staging-db-local.sh` builds a local dump of the staging MySQL database and restores it into the local Docker MySQL service.

Use this when you want the backend API to run locally against staging-like data.

## What It Does

- Connects to staging MySQL directly or through an optional AWS SSM tunnel.
- Dumps tables into `.staging-db-dump/current`.
- Resumes work when a previous dump stopped halfway.
- Re-dumps affected tables when schema drift is detected.
- Starts Docker Desktop on macOS when configured.
- Starts and waits for the local Docker MySQL service before restore.
- Replaces the configured local database with the dump.

## What It Does Not Do

This is reliable and resumable, but it is not a perfect point-in-time clone.

Each table or chunk is dumped with `--single-transaction`. If the script retries later, that retry can see newer staging data. For a strict single moment in time, use an RDS snapshot or run one uninterrupted dump inside AWS.

## Prerequisites

Required:

- Docker Desktop
- Local Docker MySQL service from this repo
- `mysql` client
- `mysqldump`
- `gzip`

Required only for automatic SSM tunnel mode:

- AWS CLI
- AWS Session Manager plugin
- AWS credentials that can start an SSM session to the configured target

The script uses the normal AWS CLI credential chain. That means these all work:

- `~/.aws/credentials` default profile
- `AWS_PROFILE=some-profile`
- AWS SSO cached credentials
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`

`aws sso login --profile some-profile` is only needed when the selected AWS profile uses SSO and the cached SSO session has expired.

## Environment File

Create `.env.staging-db.local` in the repo root. The file is sourced as shell, so keep it local and trusted.

Example:

```bash
STAGING_DB_NAME=...
STAGING_DB_USER_READ=...
STAGING_DB_PASS_READ=...

# If using automatic SSM tunnel mode:
STAGING_SSM_TARGET=...
STAGING_AWS_REGION=eu-west-1
STAGING_DB_HOST_READ=...
STAGING_DB_PORT=3306
STAGING_DB_TUNNEL_HOST=127.0.0.1
STAGING_DB_TUNNEL_PORT=3307

# Local Docker MySQL:
LOCAL_DB_NAME=OM6529
LOCAL_DB_SERVICE=mysql
LOCAL_DB_ROOT_USER=root
LOCAL_DB_ROOT_PASS=password
```

Do not commit this file.

## Commands

Resume an existing dump or create one if none exists:

```bash
npm run db:staging:resume
```

Archive the old dump and start fresh:

```bash
npm run db:staging:fresh
```

Dump staging only, without restoring local MySQL:

```bash
bash scripts/sync-staging-db-local.sh --dump-only
```

Restore an existing dump only, without contacting staging or AWS:

```bash
bash scripts/sync-staging-db-local.sh --restore-only --yes
```

## After Restarting Your Mac

If your dump already exists and you only need local MySQL restored:

```bash
bash scripts/sync-staging-db-local.sh --restore-only --yes
```

Then start the API:

```bash
cd src/api-serverless
npm run dev
```

If Docker Desktop is closed, the script can start it when `AUTO_START_DOCKER=true`.

## AWS And Tunnels

The script only uses AWS when `STAGING_SSM_TARGET` is set.

If `STAGING_SSM_TARGET` is not set, the script assumes `STAGING_DB_TUNNEL_HOST` and `STAGING_DB_TUNNEL_PORT` already point at a reachable MySQL endpoint. For example, you can open your own tunnel outside the script.

If `STAGING_SSM_TARGET` is set, the script starts:

```bash
aws ssm start-session
```

It does not choose a login method. AWS CLI decides credentials from your normal AWS setup.

## Dump Files

The default dump directory is:

```bash
.staging-db-dump/current
```

This directory is ignored by git.

Fresh mode archives the old dump first, then removes the archive only after the new run succeeds.

## Troubleshooting

`Missing .env.staging-db.local`

Create the env file in the repo root.

`aws: command not found`

Install AWS CLI, or unset `STAGING_SSM_TARGET` and provide your own tunnel.

`Session Manager plugin not found`

Install the AWS Session Manager plugin. It is only needed for automatic SSM tunnel mode.

`SSM tunnel did not become ready`

Check AWS credentials, `STAGING_SSM_TARGET`, `STAGING_AWS_REGION`, and `STAGING_DB_HOST_READ`. Also check `.staging-db-dump/current/logs/ssm-tunnel.log`.

`Access denied` from MySQL

Check staging read credentials or local Docker MySQL root credentials.

`Docker is not ready`

Open Docker Desktop or leave `AUTO_START_DOCKER=true` and rerun.

`Dump is incomplete`

Run the resume command again. The script should reuse valid completed chunks and retry missing or invalid pieces.

## Safety Notes

- Restore mode replaces the configured local database.
- Never point local restore variables at a shared or production database.
- Keep `.env.staging-db.local` private.
- Prefer `--restore-only` after a completed dump when you only need to rebuild local MySQL.
