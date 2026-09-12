#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "Usage: $0 <branch> <staging|prod> <service>... [-- release_input=value ...]" >&2
  echo "List the required services in dependency order; each run must succeed before the next starts." >&2
  exit 2
fi
deploy_branch="$1"
deploy_environment="$2"
shift 2
deploy_services=()
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
  deploy_services+=("$1")
  shift
done
if [ "$#" -gt 0 ]; then shift; fi
if [ "${#deploy_services[@]}" -eq 0 ]; then exit 2; fi
deploy_script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for deploy_service in "${deploy_services[@]}"; do
  bash "$deploy_script_directory/deploy-lambda.sh" \
    "$deploy_branch" "$deploy_environment" "$deploy_service" "$@"
done
