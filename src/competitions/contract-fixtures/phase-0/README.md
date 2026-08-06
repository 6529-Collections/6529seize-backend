# Phase 0 permanent GET contract locks

These three files are byte-for-byte copies of the accepted Phase 0 evidence in
`6529seize-frontend/ops/roadmap/waves-multi-competition/phase-0/baseline`.
They are deliberately stored at the backend enforcement boundary so backend CI
does not depend on a sibling checkout. Do not regenerate or relax them when an
implementation changes; update them only through a separately accepted
compatibility decision.

- OpenAPI snapshot: 183 permanent GET operations and their reachable schemas.
- Runtime route manifest: 296 permanent mounted GET route shapes.
- Representative fixtures: synthetic legacy/native mapping, pagination, and
  masked-error cases.

## Accepted retirements

The Simple Release Bus V1 operational GET routes are retired by the accepted
V1-removal decision in backend PR #1831. The immutable baseline remains
byte-for-byte intact for auditability; the runtime census excludes only these
four authenticated operational routes:

- `/deploy/release-bus/controls`
- `/deploy/release-candidates`
- `/deploy/release-trains`
- `/deploy/release-trains/:id`

## Accepted additive enum extensions

The subscription coverage notification contract adds the
`SUBSCRIPTION_COVERAGE` value to `ApiNotificationCause`. This exact additive
extension is accepted so both notification API versions can expose the new
first-class system notification. The immutable Phase 0 snapshot remains
unchanged, and the compatibility test permits no other enum additions.

The same accepted extension makes `related_identity` nullable in both
notification response versions. Subscription coverage is an actorless system
notification, so fabricating a related profile would be misleading. No other
reference or nullability change is permitted by the compatibility test.

## Accepted settings retirement

The obsolete `ApiSeizeSettings.all_drops_notifications_subscribers_limit`
field is retired by the accepted all-message notification limit removal. The
immutable Phase 0 snapshot remains unchanged, and the compatibility test
permits no other settings-field removal.
