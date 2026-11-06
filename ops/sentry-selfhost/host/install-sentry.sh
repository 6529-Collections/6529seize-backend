#!/usr/bin/env bash
# Installs or upgrades getsentry/self-hosted at a pinned release. Idempotent;
# run as root through scripts/run-on-host.sh after bootstrap-host.sh.
#
# Required environment:
#   SELF_HOSTED_VERSION  release tag, e.g. 26.10.1 (check the upgrade hard stops first)
#   SELF_HOSTED_COMMIT   the commit that tag must resolve to
#   URL_PREFIX           public URL, e.g. https://sentry.6529.io
#   ADMIN_EMAIL          system.admin-email
#   MAIL_FROM            From address (an address on the SES domain identity)
#   MAIL_DOMAIN          SES domain identity, e.g. sentry.6529.io
#   AWS_REGION           region holding the /sentry-selfhost parameters
# Optional: SES_PARAMETER_PREFIX (default /sentry-selfhost/ses). Without those
# parameters mail stays local to the bundled SMTP container.
#
# Never echo secrets from this script: SSM Run Command keeps its output.
set -euo pipefail

: "${SELF_HOSTED_VERSION:?}" "${SELF_HOSTED_COMMIT:?}" "${URL_PREFIX:?}" "${ADMIN_EMAIL:?}"
: "${MAIL_FROM:?}" "${MAIL_DOMAIN:?}" "${AWS_REGION:?}"
SES_PARAMETER_PREFIX="${SES_PARAMETER_PREFIX:-/sentry-selfhost/ses}"

here="$(cd "$(dirname "$0")" && pwd)"
dir=/srv/sentry/self-hosted
log() { printf '[install-sentry] %s\n' "$*"; }

# The values are rendered into sed replacements and Python/YAML string
# literals, so accept only their expected shapes.
require_format() {
  local name="$1" pattern="$2"
  [[ "${!name}" =~ $pattern ]] || { log "$name has an unexpected format"; exit 1; }
}
require_format SELF_HOSTED_VERSION '^[0-9]+\.[0-9]+\.[0-9]+$'
require_format SELF_HOSTED_COMMIT '^[0-9a-f]{40}$'
require_format URL_PREFIX '^https://[a-z0-9.-]+$'
require_format ADMIN_EMAIL '^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$'
require_format MAIL_FROM '^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$'
require_format MAIL_DOMAIN '^[a-z0-9.-]+$'
require_format AWS_REGION '^[a-z0-9-]+$'
require_format SES_PARAMETER_PREFIX '^/[A-Za-z0-9/_.-]+$'

mountpoint -q /srv || { log "/srv is not mounted; run bootstrap-host.sh first"; exit 1; }
mkdir -p /srv/sentry

# --- pinned checkout -----------------------------------------------------------
if [[ ! -d "$dir/.git" ]]; then
  git clone --quiet --no-checkout https://github.com/getsentry/self-hosted.git "$dir"
fi
git -C "$dir" fetch --quiet --force origin "refs/tags/${SELF_HOSTED_VERSION}:refs/tags/${SELF_HOSTED_VERSION}"
resolved="$(git -C "$dir" rev-parse "refs/tags/${SELF_HOSTED_VERSION}^{commit}")"
if [[ "$resolved" != "$SELF_HOSTED_COMMIT" ]]; then
  log "tag ${SELF_HOSTED_VERSION} resolves to $resolved, expected $SELF_HOSTED_COMMIT"
  exit 1
fi
git -C "$dir" -c advice.detachedHead=false checkout --quiet --force "$SELF_HOSTED_COMMIT"
cd "$dir"

# --- configuration -------------------------------------------------------------
render() {
  local template="$1"
  sed -e "s|__URL_PREFIX__|${URL_PREFIX}|g" \
    -e "s|__ADMIN_EMAIL__|${ADMIN_EMAIL}|g" \
    -e "s|__MAIL_FROM__|${MAIL_FROM}|g" \
    -e "s|__MAIL_DOMAIN__|${MAIL_DOMAIN}|g" "$template"
}
apply_managed_block() {
  local target="$1" block="$2"
  sed -i '/^# >>> 6529 sentry-selfhost overrides/,/^# <<< 6529 sentry-selfhost overrides/d' "$target"
  printf '\n' >>"$target"
  render "$block" >>"$target"
}
[[ -f sentry/sentry.conf.py ]] || cp sentry/sentry.conf.example.py sentry/sentry.conf.py
[[ -f sentry/config.yml ]] || cp sentry/config.example.yml sentry/config.yml
apply_managed_block sentry/sentry.conf.py "$here/sentry.conf.overrides.py"
apply_managed_block sentry/config.yml "$here/config.overrides.yml"

read_parameter() {
  local name="$1"
  aws ssm get-parameter --region "$AWS_REGION" --name "$name" --with-decryption \
    --query Parameter.Value --output text 2>/dev/null || true
}
env_custom=.env.custom
launchpad_secret="$(sed -n 's/^LAUNCHPAD_RPC_SHARED_SECRET=//p' "$env_custom" 2>/dev/null || true)"
[[ -n "$launchpad_secret" ]] || launchpad_secret="$(openssl rand -hex 32)"
ses_user="$(read_parameter "$SES_PARAMETER_PREFIX/smtp-username")"
ses_password="$(read_parameter "$SES_PARAMETER_PREFIX/smtp-password")"
(
  umask 077
  {
    echo "COMPOSE_PROFILES=errors-only"
    echo "SENTRY_EVENT_RETENTION_DAYS=90"
    echo "SENTRY_BIND=9000"
    echo "SENTRY_MAIL_HOST=${MAIL_DOMAIN}"
    echo "LAUNCHPAD_RPC_SHARED_SECRET=${launchpad_secret}"
    if [[ -n "$ses_user" && -n "$ses_password" ]]; then
      echo "SES_USER=${ses_user}"
      echo "SES_PASSWORD=${ses_password}"
      echo "SES_REGION=${AWS_REGION}"
    fi
  } >"$env_custom.tmp"
  mv "$env_custom.tmp" "$env_custom"
)
if [[ -n "$ses_user" && -n "$ses_password" ]]; then
  log "mail relays through SES ($AWS_REGION)"
else
  log "SES SMTP parameters not found; outbound mail is not relayed yet"
fi
unset ses_user ses_password launchpad_secret

cat >/usr/local/sbin/sentry-compose <<'SH'
#!/usr/bin/env bash
# docker compose for the self-hosted Sentry stack with its .env.custom overrides.
cd /srv/sentry/self-hosted && exec docker compose --env-file .env --env-file .env.custom "$@"
SH
chmod 0755 /usr/local/sbin/sentry-compose

# --- install and start -----------------------------------------------------------
log "running install.sh for ${SELF_HOSTED_VERSION} (errors-only)"
./install.sh \
  --skip-user-creation \
  --no-report-self-hosted-issues \
  --skip-commit-check \
  --apply-automatic-config-updates
log "starting the stack"
/usr/local/sbin/sentry-compose up --wait --remove-orphans
/usr/local/sbin/sentry-compose ps --format '{{.Service}} {{.Status}}' | sort
code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9000/_health/)"
log "local /_health/ -> $code"
[[ "$code" == "200" ]]
log "done"
