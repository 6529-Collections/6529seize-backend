import type { IdentityNotificationEntity } from '@/entities/IIdentityNotification';
import type {
  ViewNotificationKey,
  ViewPushRow
} from '@/notifications/view/notification-view-push.db';

/**
 * What a push is sent, acknowledged and remembered under. An
 * identity_notifications row keeps its id as its key, so delivery receipts
 * written before still apply. A notification_view row queued by its key
 * uses that key, because view ids repeat across people.
 */
export type PushKey = number | string;

export const viewPushKey = (key: ViewNotificationKey): string =>
  `view:${key.identity_id}:${key.source_key}`;

/**
 * A view row in the shape the push worker reads. Its id is the one the
 * notifications feed shows in `on` mode, so the app can match the push to
 * the feed; its read state is the view's.
 */
export function viewRowAsNotification(
  row: ViewPushRow
): IdentityNotificationEntity {
  return {
    id: row.id,
    identity_id: row.identity_id,
    additional_identity_id: row.additional_identity_id,
    related_drop_id: row.related_drop_id,
    related_drop_part_no: row.related_drop_part_no,
    related_drop_2_id: row.related_drop_2_id,
    related_drop_2_part_no: row.related_drop_2_part_no,
    cause: row.cause,
    // TypeORM hands the worker this json column parsed, typed as a string.
    additional_data: row.additional_data as unknown as string,
    created_at: row.created_at,
    read_at: row.read_at,
    visibility_group_id: row.visibility_group_id,
    wave_id: row.wave_id
  };
}
