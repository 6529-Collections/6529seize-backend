#!/usr/bin/env bash
# Read-only checks of the running stack: services, health, retention and the
# settings that keep it from calling Sentry the company.
set -euo pipefail
sc=/usr/local/sbin/sentry-compose

echo "== services"
$sc ps --format '{{.Service}} {{.Status}}' | sort
echo "== health"
curl -s -o /dev/null -w 'local /_health/ %{http_code}\n' http://127.0.0.1:9000/_health/
echo "== overrides"
grep -E '^(COMPOSE_PROFILES|SENTRY_EVENT_RETENTION_DAYS|SENTRY_BIND|SENTRY_MAIL_HOST)=' /srv/sentry/self-hosted/.env.custom
grep -c '^SES_USER=' /srv/sentry/self-hosted/.env.custom | sed 's/^/SES relay configured: /'
echo "== effective settings"
$sc exec -T web sentry exec -c '
from django.conf import settings
from sentry import options
for name in ("SENTRY_BEACON", "SENTRY_AIR_GAP", "SENTRY_SELF_HOSTED_ERRORS_ONLY",
             "SENTRY_RELEASE_REGISTRY_BASEURL", "SENTRY_FRONTEND_DSN", "SECURE_PROXY_SSL_HEADER"):
    print(name, getattr(settings, name, None))
print("backend_dsn", settings.SENTRY_SDK_CONFIG.get("backend_dsn"))
for key in ("system.url-prefix", "system.event-retention-days", "auth.allow-registration",
            "beacon.anonymous", "mail.from", "mail.host"):
    print(key, options.get(key))
'
echo "== beacon task log (last 24h)"
$sc logs --no-color --since 24h taskworker taskscheduler 2>/dev/null | grep -i 'beacon' | tail -n 5 || echo "no beacon log lines"
echo "== established outbound TCP peers"
ss -Htn state established | awk '{print $4}' | grep -v -E '^(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[)' | sort | uniq -c | sort -rn | head -n 20 || true
