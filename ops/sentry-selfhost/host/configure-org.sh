#!/usr/bin/env bash
# Names the single organization, requires two-factor authentication for its
# members and turns off join requests. Idempotent; run after create-admin.sh.
#
# Required environment: ORG_SLUG (e.g. seize-ff), ORG_NAME (e.g. 6529).
#
# Organization-wide 2FA is set directly on the model because the API refuses to
# enable it for a user who has not enrolled 2FA yet. Members without 2FA are
# sent to the 2FA setup page; an active superuser session is exempt, so the
# owner should still enroll 2FA at first login.
set -euo pipefail

: "${ORG_SLUG:?}" "${ORG_NAME:?}"
/usr/local/sbin/sentry-compose exec -T -e ORG_SLUG="$ORG_SLUG" -e ORG_NAME="$ORG_NAME" web sentry exec -c '
import os
import sentry
from sentry import options
from sentry.models.organization import Organization
from sentry.services.organization.provisioning import organization_provisioning_service

slug = os.environ["ORG_SLUG"]
name = os.environ["ORG_NAME"]
orgs = list(Organization.objects.all())
if len(orgs) != 1:
    raise SystemExit(f"expected exactly one organization, found {len(orgs)}")
org = orgs[0]
if org.slug != slug:
    organization_provisioning_service.change_organization_slug(organization_id=org.id, slug=slug)
    org.refresh_from_db()
changed = False
if org.name != name:
    org.name = name
    changed = True
if not org.flags.require_2fa:
    org.flags.require_2fa = True
    changed = True
if changed:
    org.save()
org.refresh_from_db()

# Closed membership: no "Request to join" form on the login page.
if org.get_option("sentry:join_requests", True):
    org.update_option("sentry:join_requests", False)

# The required options are set in config.yml; mark this version as configured so
# the superuser is not sent through the first-run wizard.
if options.get("sentry:version-configured") != sentry.get_version():
    options.set("sentry:version-configured", sentry.get_version())

join_requests = org.get_option("sentry:join_requests", True)
print(
    f"ORG slug={org.slug} name={org.name} require_2fa={bool(org.flags.require_2fa)}"
    f" join_requests={join_requests}"
)
'
