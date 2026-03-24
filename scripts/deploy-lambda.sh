#!/usr/bin/env bash
set -euo pipefail

BRANCH="$1"
ENVIRONMENT="$2"
SERVICE="$3"
REPO="6529-Collections/6529seize-backend"

echo "Dispatching workflow..."
echo "  repo:    $REPO"
echo "  branch:  $BRANCH"
echo "  env:     $ENVIRONMENT"
echo "  service: $SERVICE"
echo

echo "Running dispatch..."
gh workflow run "Deploy a service" \
  --ref "$BRANCH" \
  -f environment="$ENVIRONMENT" \
  -f service="$SERVICE" \
  -R "$REPO"
