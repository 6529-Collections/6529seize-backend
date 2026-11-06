#!/usr/bin/env bash
# Creates the owner's Sentry superuser once. The password is generated on this
# host, written to SSM Parameter Store as a SecureString before the user exists,
# and never printed. Idempotent: an existing user is left unchanged.
#
# Required environment: ADMIN_EMAIL, PASSWORD_PARAMETER (e.g.
# /sentry-selfhost/admin/initial-password), AWS_REGION.
set -euo pipefail

: "${ADMIN_EMAIL:?}" "${PASSWORD_PARAMETER:?}" "${AWS_REGION:?}"
log() { printf '[create-admin] %s\n' "$*"; }
sc=/usr/local/sbin/sentry-compose

user_exists="$($sc exec -T -e ADMIN_EMAIL="$ADMIN_EMAIL" web sentry exec -c '
import os
from sentry.users.models.user import User
print("USER_EXISTS=" + str(User.objects.filter(email__iexact=os.environ["ADMIN_EMAIL"]).exists()))
' 2>/dev/null | sed -n 's/^USER_EXISTS=//p')"
if [[ "$user_exists" == "True" ]]; then
  log "a user with that email already exists; nothing to do"
  exit 0
fi
[[ "$user_exists" == "False" ]] || { log "could not query users"; exit 1; }

if aws ssm get-parameter --region "$AWS_REGION" --name "$PASSWORD_PARAMETER" >/dev/null 2>&1; then
  log "reusing the password already stored in $PASSWORD_PARAMETER"
  password="$(aws ssm get-parameter --region "$AWS_REGION" --name "$PASSWORD_PARAMETER" \
    --with-decryption --query Parameter.Value --output text)"
else
  password="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)"
  [[ ${#password} -eq 40 ]] || { log "password generation failed"; exit 1; }
  aws ssm put-parameter --region "$AWS_REGION" --name "$PASSWORD_PARAMETER" --type SecureString \
    --description "Initial password of the self-hosted Sentry owner account. Change it and enable 2FA at first login." \
    --tags Key=Project,Value=sentry-selfhost Key=Owner,Value=6529 \
    --value "$password" >/dev/null
  log "stored the generated password in $PASSWORD_PARAMETER"
fi

# The password travels on stdin, not in docker exec arguments.
printf '%s\n' "$password" | $sc exec -T web sh -c \
  'IFS= read -r p; exec sentry createuser --email "$1" --password "$p" --superuser --no-input' \
  createuser "$ADMIN_EMAIL" | grep -v -i password || true
unset password

created="$($sc exec -T -e ADMIN_EMAIL="$ADMIN_EMAIL" web sentry exec -c '
import os
from sentry.users.models.user import User
u = User.objects.get(email__iexact=os.environ["ADMIN_EMAIL"])
print("CREATED=" + str(u.is_superuser and u.has_usable_password()))
' 2>/dev/null | sed -n 's/^CREATED=//p')"
[[ "$created" == "True" ]] || { log "user was not created"; exit 1; }
log "created superuser $ADMIN_EMAIL"
