---
name: identity-notifications
description: Add or change identity notification types in the 6529 SEIZE backend by updating notification causes, domain data types, DB-to-domain mappers, UserNotifier creation methods, push notification rendering/settings, notification API mappings, OpenAPI enums, and tests. Use when adding new notification types, creating identity notifications, changing notification payloads, or extending push/API notification behavior.
---

# Identity Notifications

Use this workflow when a new event should appear in identity notification lists, push notifications, or both.

## Workflow

1. Define the notification contract before editing:
   - cause enum in `UPPER_SNAKE_CASE`
   - recipient, actor, related drop(s), wave, visibility group, and custom `additional_data`
   - trigger location and transaction boundary
   - whether self-notifications must be skipped
   - API related identities/drops needed by the frontend
   - push title, body, image, deep link, and settings key
2. Update the core domain files:
   - add the cause to `IdentityNotificationCause` in `src/entities/IIdentityNotification.ts`
   - add a data interface and full notification interface in `src/notifications/user-notification.types.ts`
   - add the new interface to the `UserNotification` union
3. Update `src/notifications/user-notification.mapper.ts`:
   - add a switch case in `entityToNotification()`
   - map entity columns and `additional_data` into the new typed payload
   - use non-null assertions only for columns guaranteed by the notifier
4. Add or update `UserNotifier` in `src/notifications/user.notifier.ts`:
   - insert `identity_id` as the recipient
   - insert `additional_identity_id` as the actor when there is one
   - fill `related_drop_id`, `related_drop_part_no`, `related_drop_2_id`, `related_drop_2_part_no`, and `wave_id` consistently
   - store only custom fields in `additional_data`
   - pass `visibility_group_id`
   - pass `connection` or `ctx.connection` when inside a transaction
   - skip self-notifications where the existing notification semantics do
5. Wire the notifier call after the primary action succeeds. Decide deliberately whether notification failure should fail the parent operation.
6. Update push notification behavior in `src/pushNotificationsHandler/identityPushNotifications.ts` when the cause should produce a push:
   - add a `CAUSE_TO_SETTING_KEY` entry when users should be able to disable it with an existing or new setting
   - add a `generateNotificationData()` switch case
   - add a focused handler that returns `{ title, body, data, imageUrl }` or the skip sentinel when appropriate
   - use existing helpers such as `getDropSerialNo`, `getDropPart`, `getDrop`, and `getWaveEntityOrThrow`
   - handle deleted or missing related entities deliberately
7. Update API notification mapping in `src/api-serverless/src/notifications/notifications.api.service.ts`:
   - add related IDs in `getAllRelatedIds()`
   - update `mapToApiNotificationV2WithoutRelatedWave()` or related V2 helpers
   - update legacy `mapToApiNotification()` if the V1 route still exposes the cause
   - keep `enums.resolveOrThrow(ApiNotificationCause, notificationCause)` compatible with generated enum values
8. Update `src/api-serverless/openapi.yaml`:
   - add the cause to `ApiNotificationCause`
   - add or update response fields only if the API shape changes
   - run `cd src/api-serverless && npm run restructure-openapi && npm run generate`
9. Add or update focused tests:
   - `src/notifications/user-notification-mapper.test.ts`
   - `src/notifications/user.notifier.test.ts`
   - `src/pushNotificationsHandler/*push-notification*.test.ts` when push output changes
   - `src/api-serverless/src/notifications/notifications-api-service.test.ts`
10. Run `npm run lint` from the repo root.

## Storage Fields

Prefer existing columns before adding schema:

- `identity_id`: recipient
- `additional_identity_id`: actor or related identity
- `related_drop_id` and `related_drop_part_no`: primary drop
- `related_drop_2_id` and `related_drop_2_part_no`: secondary drop
- `wave_id`: wave context
- `visibility_group_id`: notification visibility restriction
- `additional_data`: custom JSON fields only

## Common Patterns

- Identity action: recipient in `identity_id`, actor in `additional_identity_id`, no drop.
- Drop action: recipient is the drop author, actor in `additional_identity_id`, primary drop in `related_drop_id`, wave in `wave_id`.
- Reply/quote action: new drop in `related_drop_id`, original drop in `related_drop_2_id`.
- Wave action: affected identities in `identity_id`, actor in `additional_identity_id`, wave in `wave_id`.

## Validation

- [ ] Enum value added to `IdentityNotificationCause` in `src/entities/IIdentityNotification.ts`.
- [ ] Data interface created in `src/notifications/user-notification.types.ts`.
- [ ] Notification interface created and added to `UserNotification` union.
- [ ] Mapper case added in `src/notifications/user-notification.mapper.ts`.
- [ ] Notifier method created in `src/notifications/user.notifier.ts`.
- [ ] Notifier wired up in trigger location.
- [ ] Push settings and handler updated in `src/pushNotificationsHandler/identityPushNotifications.ts` when push applies.
- [ ] `getAllRelatedIds()` case added in notifications API service.
- [ ] V2 API mapping updated, and V1 mapping updated if still exposed.
- [ ] OpenAPI schema updated with new enum value.
- [ ] Types regenerated with `cd src/api-serverless && npm run restructure-openapi && npm run generate`.
- [ ] Tests cover mapper, notifier, push output, and API mapping as applicable.
- [ ] `npm run lint` passes.
