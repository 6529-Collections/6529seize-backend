#!/usr/bin/env bash
# Evidence that the Sentry host does not contact Sentry the company: queries the
# VPC's Route 53 Resolver query log for Sentry-company names (blocked by the DNS
# Firewall) and lists every distinct name the VPC resolved in the window.
#
# usage: [AWS_REGION=us-east-1] scripts/verify-no-phone-home.sh [hours=24]
set -euo pipefail
# Git Bash on Windows would rewrite the leading-slash names below into paths.
export MSYS_NO_PATHCONV=1

hours="${1:-24}"
region="${AWS_REGION:-us-east-1}"
log_group="/sentry-selfhost/dns-queries"
end="$(date -u +%s)"
start="$((end - hours * 3600))"

run_query() {
  local query="$1" id status
  id="$(aws logs start-query --region "$region" --log-group-name "$log_group" \
    --start-time "$start" --end-time "$end" --query-string "$query" --query queryId --output text)"
  while :; do
    status="$(aws logs get-query-results --region "$region" --query-id "$id" --query status --output text)"
    case "$status" in
      Scheduled | Running) sleep 2 ;;
      *) break ;;
    esac
  done
  # A failed, cancelled or timed-out query returns no rows; never read that as "none".
  if [[ "$status" != "Complete" ]]; then
    echo "Logs Insights query ended with status $status" >&2
    exit 1
  fi
  aws logs get-query-results --region "$region" --query-id "$id" --output json |
    jq -r '.results[] | map(.value // "-") | join("\t")'
}

echo "== window: last ${hours}h"
total="$(run_query 'stats count(*) as n')"
echo "== DNS queries logged from the VPC: ${total:-0}"
if [[ "${total:-0}" == "0" ]]; then
  echo "no queries logged: query logging is not working, so this window proves nothing" >&2
  exit 1
fi
echo "== Sentry-company names queried (any action)"
company="$(run_query 'fields query_name, firewall_rule_action
| filter query_name like /(?i)(^|\.)(sentry\.io|getsentry\.net|sentry-cdn\.com|sentry\.dev)\.?$/
| stats count(*) as n by query_name, firewall_rule_action
| sort n desc')"
if [[ -z "$company" ]]; then
  echo "none"
else
  echo "$company"
fi
echo "== queries blocked by the DNS Firewall"
blocked="$(run_query 'filter firewall_rule_action = "BLOCK" | stats count(*) as n')"
echo "${blocked:-0}"
echo "== all names resolved by the VPC"
run_query 'stats count(*) as n by query_name | sort n desc | limit 200'
