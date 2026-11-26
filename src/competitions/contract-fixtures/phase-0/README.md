# Phase 0 permanent GET contract locks

These three files mirror the accepted Phase 0 evidence in
`6529seize-frontend/ops/roadmap/waves-multi-competition/phase-0/baseline`.
Backend CI reads these local copies. Update them only through a separately
accepted compatibility decision.

- OpenAPI snapshot: 183 permanent GET operations and their reachable schemas.
- Runtime route manifest: 288 retained GET route shapes.
- Representative fixtures: synthetic legacy/native mapping, pagination, and
  masked-error cases.

## Accepted retirements

The Simple Release Bus V1 operational GET routes are retired by the accepted
V1-removal decision in backend PR #1831. The runtime census excludes these
four authenticated operational routes:

- `/deploy/release-bus/controls`
- `/deploy/release-candidates`
- `/deploy/release-trains`
- `/deploy/release-trains/:id`

The runtime census also records the undocumented Quick Vote alias
`/api/wave/:id/undiscovered-drop` as retired. The original manifest records
the historical mount.

[Backend PR #2625](https://github.com/6529-Collections/6529seize-backend/pull/2625)
approves removal of eight operational GET records from the retained inventory.
Three of those records were for routes already retired in
[backend PR #1965](https://github.com/6529-Collections/6529seize-backend/pull/1965).
The source revision identifies the original Phase 0 capture. The counts reflect
the amended inventory.

## Accepted Alchemy search retirement

The address-only migration in backend PR #1974 retires the deprecated Alchemy
collection-name search. `/alchemy-proxy/collections` remains mounted but returns
an uncached HTTP 410 with the legacy `{ error }` payload. The runtime census
accepts only this route's cache change; its mount/auth checks and all other
routes remain enforced. The immutable baseline files are unchanged. The Alchemy
route tests cover the terminal error and absence of upstream/cache middleware.

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
