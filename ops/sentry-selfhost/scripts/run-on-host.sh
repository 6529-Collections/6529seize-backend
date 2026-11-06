#!/usr/bin/env bash
# Runs one host script on the Sentry instance through SSM Run Command, waits for
# it, and prints its output. Every host/ file is shipped alongside the script, so
# scripts can read their sibling config files.
#
# usage: INSTANCE_ID=i-... [AWS_REGION=us-east-1] scripts/run-on-host.sh host/<script>.sh [KEY=VALUE ...]
#
# KEY=VALUE pairs become the script's environment. They are stored in the SSM
# command history: never pass secrets this way. Secrets live in SSM Parameter
# Store and are read on the host.
set -euo pipefail
# Git Bash on Windows would rewrite the leading-slash names below into paths.
export MSYS_NO_PATHCONV=1
# Command output can contain non-ASCII characters; keep the AWS CLI on UTF-8.
export PYTHONUTF8=1

script="${1:?usage: run-on-host.sh host/<script>.sh [KEY=VALUE ...]}"
shift
: "${INSTANCE_ID:?INSTANCE_ID is required}"
region="${AWS_REGION:-us-east-1}"
log_group="/sentry-selfhost/ssm-commands"
here="$(cd "$(dirname "$0")/.." && pwd)"
host_dir="$here/host"
[[ -f "$host_dir/$(basename "$script")" ]] || { echo "unknown host script: $script" >&2; exit 2; }

env_args=()
for kv in "$@"; do
  [[ "$kv" =~ ^[A-Z_][A-Z0-9_]*=[^\'[:space:]]*$ ]] || { echo "bad KEY=VALUE: $kv" >&2; exit 2; }
  env_args+=("'$kv'")
done

remote_dir=/root/sentry-selfhost
commands=("set -eu" "rm -rf $remote_dir && mkdir -p $remote_dir")
for file in "$host_dir"/*; do
  name="$(basename "$file")"
  commands+=("echo $(base64 -w0 "$file") | base64 -d > $remote_dir/$name")
done
commands+=("env ${env_args[*]:-} bash $remote_dir/$(basename "$script")")

parameters="$(printf '%s\n' "${commands[@]}" | jq -R . | jq -s '{commands: ., executionTimeout: ["7200"]}')"
command_id="$(aws ssm send-command --region "$region" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "sentry-selfhost $(basename "$script")" \
  --parameters "$parameters" \
  --cloud-watch-output-config "CloudWatchOutputEnabled=true,CloudWatchLogGroupName=$log_group" \
  --query Command.CommandId --output text)"
echo "command $command_id ($(basename "$script")); full output in $log_group"

while :; do
  status="$(aws ssm get-command-invocation --region "$region" --command-id "$command_id" \
    --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)"
  case "$status" in
    Pending | InProgress | Delayed) sleep 15 ;;
    *) break ;;
  esac
done
aws ssm get-command-invocation --region "$region" --command-id "$command_id" --instance-id "$INSTANCE_ID" \
  --query '[StandardOutputContent, StandardErrorContent]' --output text
echo "status: $status"
[[ "$status" == "Success" ]]
