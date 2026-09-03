#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "Usage: $0 <branch> <staging|prod> <service> [release_input=value ...]" >&2
  exit 2
fi

deploy_branch="$1"
deploy_environment="$2"
deploy_service="$3"
shift 3
deploy_repository="6529-Collections/6529seize-backend"
case "$deploy_environment:$deploy_branch" in
  staging:1a-staging|prod:main) ;;
  *) echo "Use 1a-staging for staging or main for prod." >&2; exit 2 ;;
esac
[[ "$deploy_service" =~ ^[A-Za-z0-9]+$ ]] || exit 2

deploy_inputs=(-f "environment=$deploy_environment" -f "service=$deploy_service")
for deploy_input in "$@"; do
  case "$deploy_input" in
    release_pull_request=*|release_group_services=*|release_note_publish=*|release_note_groups=*|release_note_opt_out=*)
      deploy_inputs+=(-f "$deploy_input") ;;
    *) echo "Unsupported deployment input: ${deploy_input%%=*}" >&2; exit 2 ;;
  esac
done

deploy_actor="$(gh api user --jq .login)"
deploy_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
list_deploy_runs() {
  gh run list --repo "$deploy_repository" --workflow deploy.yml \
    --branch "$deploy_branch" --event workflow_dispatch --user "$deploy_actor" \
    --limit 100 --json databaseId,displayTitle,createdAt
}
prior_deploy_runs="$(list_deploy_runs | jq '[.[].databaseId]')"
gh workflow run deploy.yml --repo "$deploy_repository" --ref "$deploy_branch" "${deploy_inputs[@]}"

# Match the newly dispatched service run, never a different actor's deployment.
for deploy_attempt in {1..60}; do
  new_deploy_runs="$(list_deploy_runs | jq \
    --arg title "Deploy $deploy_service to $deploy_environment" \
    --arg started_at "$deploy_started_at" \
    --argjson prior "$prior_deploy_runs" \
    '[.[] | select(.displayTitle == $title and .createdAt >= $started_at) | .databaseId | select(. as $id | $prior | index($id) | not)] | unique')"
  deploy_count="$(jq length <<< "$new_deploy_runs")"
  if [ "$deploy_count" -eq 1 ]; then
    deploy_run_id="$(jq -r '.[0]' <<< "$new_deploy_runs")"
    echo "Waiting for https://github.com/$deploy_repository/actions/runs/$deploy_run_id"
    gh run watch "$deploy_run_id" --repo "$deploy_repository" --exit-status
    exit 0
  fi
  if [ "$deploy_count" -gt 1 ]; then
    echo "Multiple matching deployments started; inspect Actions before continuing." >&2
    exit 1
  fi
  sleep 2
done
echo "The dispatch was accepted, but its run could not be identified; inspect Actions before retrying." >&2
exit 1
