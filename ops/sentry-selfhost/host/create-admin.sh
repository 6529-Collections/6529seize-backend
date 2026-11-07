#!/usr/bin/env bash
# Creates the owner's Sentry superuser once. The password is generated on this
# host, written to SSM Parameter Store as a SecureString before the user exists,
# and never printed or passed as a command-line argument: it moves only through
# a root-only temporary file and stdin. Idempotent: a user that already has a
# password is left unchanged.
#
# Required environment: ADMIN_EMAIL, PASSWORD_PARAMETER (under
# /sentry-selfhost/admin/, the only prefix the instance role may write),
# AWS_REGION.
set -euo pipefail

: "${ADMIN_EMAIL:?}" "${PASSWORD_PARAMETER:?}" "${AWS_REGION:?}"
log() { printf '[create-admin] %s\n' "$*"; }
sc=/usr/local/sbin/sentry-compose

[[ "$PASSWORD_PARAMETER" =~ ^/sentry-selfhost/admin/[A-Za-z0-9/_.-]+$ ]] ||
  { log "PASSWORD_PARAMETER must be under /sentry-selfhost/admin/"; exit 1; }

user_state() {
  $sc exec -T -e ADMIN_EMAIL="$ADMIN_EMAIL" web sentry exec -c '
import os
from sentry.users.models.user import User
u = User.objects.filter(email__iexact=os.environ["ADMIN_EMAIL"]).first()
if u is None:
    print("USER_STATE=none")
elif u.is_superuser and u.has_usable_password():
    print("USER_STATE=ready")
else:
    print("USER_STATE=incomplete")
' 2>/dev/null | sed -n 's/^USER_STATE=//p'
}

state="$(user_state)"
case "$state" in
  ready) log "the superuser already exists with a password; nothing to do"; exit 0 ;;
  none | incomplete) ;;
  *) log "could not query users"; exit 1 ;;
esac

umask 077
password_file="$(mktemp /root/.sentry-admin-password.XXXXXX)"
trap 'rm -f "$password_file"' EXIT

if aws ssm get-parameter --region "$AWS_REGION" --name "$PASSWORD_PARAMETER" >/dev/null 2>&1; then
  log "reusing the password already stored in $PASSWORD_PARAMETER"
  # Pipe, never redirect: the snap-packaged AWS CLI writes nothing when its
  # stdout is a file. Dropping the CLI's trailing newline makes both paths
  # hold exactly the password bytes.
  aws ssm get-parameter --region "$AWS_REGION" --name "$PASSWORD_PARAMETER" \
    --with-decryption --query Parameter.Value --output text | tr -d '\n' >"$password_file"
  [[ "$(wc -c <"$password_file")" -ge 20 ]] || { log "the stored password could not be read"; exit 1; }
else
  openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40 >"$password_file"
  [[ "$(wc -c <"$password_file")" -eq 40 ]] || { log "password generation failed"; exit 1; }
  aws ssm put-parameter --region "$AWS_REGION" --name "$PASSWORD_PARAMETER" --type SecureString \
    --description "Initial password of the self-hosted Sentry owner account. Change it and enable 2FA at first login." \
    --tags Key=Project,Value=sentry-selfhost Key=Owner,Value=6529 \
    --value "file://$password_file" >/dev/null
  log "stored the generated password in $PASSWORD_PARAMETER"
fi

if [[ "$state" == "none" ]]; then
  $sc exec -T web sentry createuser --email "$ADMIN_EMAIL" --superuser --no-password --no-input \
    >/dev/null 2>&1 || { log "sentry createuser failed"; exit 1; }
fi

# Set the password from stdin; output is reduced to a fixed marker.
set_result="$($sc exec -T -e ADMIN_EMAIL="$ADMIN_EMAIL" web sentry exec -c '
import os
import sys
from sentry.users.models.user import User
u = User.objects.get(email__iexact=os.environ["ADMIN_EMAIL"])
# A user left incomplete by an interrupted run is repaired to an active superuser.
u.is_superuser = True
u.is_active = True
u.set_password(sys.stdin.readline().rstrip("\n"))
u.save()
print("PASSWORD_SET")
' <"$password_file" 2>/dev/null | grep -x PASSWORD_SET || true)"
[[ "$set_result" == "PASSWORD_SET" ]] || { log "setting the password failed"; exit 1; }

[[ "$(user_state)" == "ready" ]] || { log "user was not created"; exit 1; }
log "created superuser $ADMIN_EMAIL"
