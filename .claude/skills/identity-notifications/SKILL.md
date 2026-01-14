---
name: identity-notifications
description: Create new identity notification types by adding enum values, type definitions, notifier methods, push handlers, and API integration. Use when adding new notification types, creating notifications, or extending the notification system.
---

# Creating New Identity Notification Types

This skill guides you through the complete process of creating a new identity notification type in the 6529 SEIZE Backend.

## Overview

Identity notifications alert users about activities relevant to them (mentions, votes, replies, etc.). Creating a new notification type involves eight steps:

1. Add enum value to `IdentityNotificationCause`
2. Define data interface and notification type
3. Add mapper case for database-to-domain conversion
4. Create notifier method in `UserNotifier`
5. Wire up the notifier call in the triggering code
6. Add push notification handler
7. Add API service mapping (two switch cases)
8. Update OpenAPI schema and regenerate

## Required Information

Before implementing, gather these details using `AskUserQuestion`:

### 1. Notification Type Name
- What should the notification be called?
- Use UPPER_SNAKE_CASE for the enum value
- Examples: `DROP_PINNED`, `WAVE_ARCHIVED`, `PROFILE_UPDATED`

### 2. Data Fields
- What information does this notification need to store?
- Available entity columns (use these when possible):
  - `identity_id` - WHO receives the notification (required)
  - `additional_identity_id` - WHO triggered it (nullable)
  - `related_drop_id` + `related_drop_part_no` - Primary drop reference (nullable)
  - `related_drop_2_id` + `related_drop_2_part_no` - Secondary drop reference (nullable)
  - `wave_id` - Associated wave (nullable)
  - `visibility_group_id` - Group visibility restriction (nullable)
  - `additional_data` - JSON column for custom fields

### 3. Trigger Location
- Where in the codebase should this notification be created?
- Common locations:
  - Drop actions: `src/drops/create-or-update-drop.use-case.ts`
  - Voting: `src/drops/vote-for-drop.use-case.ts`
  - Reactions: `src/reactions/reactions.service.ts`
  - Waves: `src/api-serverless/src/waves/wave.api.service.ts`
  - Subscriptions: `src/api-serverless/src/identity-subscriptions/identity-subscriptions.api.service.ts`

### 4. Push Notification Content
- What should the push notification title say?
- What should the body contain?
- What deep link should it open? (profile, waves, etc.)

## Implementation Steps

### Step 1: Add Enum Value

**File:** `src/entities/IIdentityNotification.ts`

Add the new cause to the enum:

```typescript
export enum IdentityNotificationCause {
  // ... existing values
  YOUR_NEW_CAUSE = 'YOUR_NEW_CAUSE'
}
```

### Step 2: Define Type Interfaces

**File:** `src/notifications/user-notification.types.ts`

Add three things:

**2a. Data interface** (what gets stored):
```typescript
export interface YourNewNotificationData {
  actor_id: string;        // Who triggered it
  recipient_id: string;    // Who receives it
  drop_id?: string;        // Related drop if applicable
  wave_id?: string;        // Related wave if applicable
  // Add custom fields as needed
}
```

**2b. Full notification interface:**
```typescript
export interface YourNewNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.YOUR_NEW_CAUSE;
  data: YourNewNotificationData;
}
```

**2c. Add to union type** (at the end of file):
```typescript
export type UserNotification =
  | IdentitySubscriptionNotification
  // ... existing types
  | YourNewNotification;  // Add here
```

### Step 3: Add Mapper Case

**File:** `src/notifications/user-notification.mapper.ts`

**3a. Add case to switch** in `entityToNotification()`:
```typescript
case IdentityNotificationCause.YOUR_NEW_CAUSE:
  return this.mapYourNewNotification(entity);
```

**3b. Add mapping method:**
```typescript
private mapYourNewNotification(
  entity: IdentityNotificationDeserialized
): YourNewNotification {
  return {
    id: entity.id,
    created_at: entity.created_at,
    read_at: entity.read_at,
    cause: IdentityNotificationCause.YOUR_NEW_CAUSE,
    data: {
      actor_id: entity.additional_identity_id!,
      recipient_id: entity.identity_id,
      drop_id: entity.related_drop_id ?? undefined,
      wave_id: entity.wave_id ?? undefined
      // Map additional_data fields if needed:
      // custom_field: entity.additional_data.custom_field
    }
  };
}
```

**Important:** Use `!` only when the field is guaranteed to be populated for this notification type.

### Step 4: Create Notifier Method

**File:** `src/notifications/user.notifier.ts`

**4a. Import your new type** at the top:
```typescript
import {
  // ... existing imports
  YourNewNotificationData
} from './user-notification.types';
```

**4b. Add notifier method:**
```typescript
public async notifyOfYourNewThing(
  data: YourNewNotificationData,
  visibility_group_id: string | null,
  connection?: ConnectionWrapper<any>
) {
  // Skip self-notifications
  if (data.actor_id === data.recipient_id) {
    return;
  }

  await this.identityNotificationsDb.insertNotification(
    {
      identity_id: data.recipient_id,
      additional_identity_id: data.actor_id,
      related_drop_id: data.drop_id ?? null,
      related_drop_part_no: null,
      related_drop_2_id: null,
      related_drop_2_part_no: null,
      wave_id: data.wave_id ?? null,
      cause: IdentityNotificationCause.YOUR_NEW_CAUSE,
      additional_data: {
        // Custom JSON fields here
      },
      visibility_group_id
    },
    connection
  );
}
```

### Step 5: Wire Up the Trigger

In the identified service/use-case, call your notifier:

```typescript
await userNotifier.notifyOfYourNewThing(
  {
    actor_id: actorIdentityId,
    recipient_id: recipientIdentityId,
    drop_id: dropId,
    wave_id: waveId
  },
  visibilityGroupId,
  connection  // Pass if inside transaction
);
```

**Important considerations:**
- Call AFTER the primary action succeeds
- Pass `connection` if inside a database transaction
- Consider if notification failure should fail the whole operation

### Step 6: Add Push Notification Handler

**File:** `src/pushNotificationsHandler/identityPushNotifications.ts`

**6a. Add case to `generateNotificationData()`:**
```typescript
case IdentityNotificationCause.YOUR_NEW_CAUSE:
  return handleYourNewThing(notification, additionalEntity);
```

**6b. Add handler function:**
```typescript
async function handleYourNewThing(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity
) {
  // Fetch related data if needed
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);

  const title = `${additionalEntity.handle} did something`;
  const body = 'View details';
  const imageUrl = additionalEntity.pfp;
  const data = {
    redirect: 'waves',  // or 'profile'
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };

  return { title, body, data, imageUrl };
}
```

**Available helpers:**
- `getDropSerialNo(dropId)` - Get drop's serial number for deep linking
- `getDropPart(notification, handle?)` - Get drop content for body text
- `getDrop(notification)` - Get full drop entity
- `getWaveEntityOrThrow(notificationId, waveId)` - Get wave entity

### Step 7: Add API Service Mapping

**File:** `src/api-serverless/src/notifications/notifications.api.service.ts`

**7a. Add case to `getAllRelatedIds()`** (~line 154):
```typescript
case IdentityNotificationCause.YOUR_NEW_CAUSE: {
  const data = notification.data;
  profileIds.push(data.actor_id);
  if (data.drop_id) {
    dropIds.push(data.drop_id);
  }
  break;
}
```

**7b. Add case to `mapToApiNotification()`** (~line 225):
```typescript
case IdentityNotificationCause.YOUR_NEW_CAUSE: {
  const data = notification.data;
  return {
    id: notification.id,
    created_at: notification.created_at,
    read_at: notification.read_at,
    cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
    related_identity: profiles[data.actor_id],
    related_drops: data.drop_id ? [drops[data.drop_id]] : [],
    additional_context: {
      wave_id: data.wave_id
      // Add custom context for frontend
    }
  };
}
```

### Step 8: Update OpenAPI Schema

**File:** `src/api-serverless/openapi.yaml`

Find `ApiNotificationCause` enum (~line 7668) and add your value:

```yaml
ApiNotificationCause:
  type: string
  enum:
    - IDENTITY_SUBSCRIBED
    - IDENTITY_MENTIONED
    # ... existing values
    - YOUR_NEW_CAUSE  # Add here
```

Then regenerate types:
```bash
cd src/api-serverless && npm run restructure-openapi && npm run generate
```

## Verification Checklist

After implementation, verify:

- [ ] Enum value added to `IdentityNotificationCause` in `src/entities/IIdentityNotification.ts`
- [ ] Data interface created in `src/notifications/user-notification.types.ts`
- [ ] Notification interface created and added to `UserNotification` union
- [ ] Mapper case added in `src/notifications/user-notification.mapper.ts`
- [ ] Notifier method created in `src/notifications/user.notifier.ts`
- [ ] Notifier wired up in trigger location
- [ ] Push handler added in `src/pushNotificationsHandler/identityPushNotifications.ts`
- [ ] `getAllRelatedIds()` case added in notifications API service
- [ ] `mapToApiNotification()` case added in notifications API service
- [ ] OpenAPI schema updated with new enum value
- [ ] Types regenerated (`cd src/api-serverless && npm run restructure-openapi && npm run generate`)
- [ ] Tests pass (`npm test`)
- [ ] Code builds (`npm run build`)

## Common Patterns

### Pattern: Simple Identity Action
- **Use For**: One user does something to another (follow, block)
- **Entity Fields**: `identity_id` (recipient), `additional_identity_id` (actor)
- **Push**: "{actor} did X to you"

### Pattern: Drop-Related Action
- **Use For**: Actions on drops (vote, react, quote, reply, mention)
- **Entity Fields**: + `related_drop_id`, `wave_id`
- **Push**: "{actor} did X to your drop" with drop content preview

### Pattern: Multi-Drop Action
- **Use For**: Actions involving two drops (quote, reply)
- **Entity Fields**: + `related_drop_id` (new drop), `related_drop_2_id` (original drop)
- **Push**: Deep link to new drop in wave context

### Pattern: Wave Action
- **Use For**: Wave-level notifications (invited, archived)
- **Entity Fields**: + `wave_id`
- **Push**: Deep link to wave

## Files Reference

| File | Purpose |
|------|---------|
| `src/entities/IIdentityNotification.ts` | Entity + enum definition |
| `src/notifications/user-notification.types.ts` | TypeScript interfaces |
| `src/notifications/user-notification.mapper.ts` | DB → domain mapping |
| `src/notifications/user.notifier.ts` | Notification creation methods |
| `src/pushNotificationsHandler/identityPushNotifications.ts` | Push rendering |
| `src/api-serverless/src/notifications/notifications.api.service.ts` | API response mapping |
| `src/api-serverless/openapi.yaml` | API schema (line ~7668) |

## Environment Requirements

For notifications to work:
- `USER_NOTIFIER_ACTIVATED=true` - Enable notification creation
- `PUSH_NOTIFICATIONS_ACTIVATED=true` - Enable push sending

## Important Considerations

1. **Self-notifications**: Always skip notifying users of their own actions
2. **Transaction handling**: Pass `connection` if inside a database transaction
3. **Wave muting**: Push notifications are automatically skipped for muted waves
4. **Deleted entities**: Handle cases where referenced profile/drop/wave was deleted
5. **TypeScript exhaustiveness**: The `assertUnreachable` pattern ensures you don't miss switch cases

## Next Steps

1. Use `AskUserQuestion` to gather the four required pieces of information:
   - Notification type name
   - Data fields needed
   - Trigger location
   - Push notification content
2. Implement each step in order (1-8)
3. Run `npm run build` to verify TypeScript compilation
4. Run `npm test` to verify tests pass
5. Test locally with `USER_NOTIFIER_ACTIVATED=true`
