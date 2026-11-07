import { DropType } from '@/entities/IDrop';
import type { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';

/** `WS_POST_OUTBOX=true` turns on the post outbox (waves plan 1.8). */
export function isDropWriteOutboxEnabled(): boolean {
  return process.env.WS_POST_OUTBOX === 'true';
}

export const DROP_WRITE_OUTBOX_PAYLOAD_VERSION = 1;

/** The notification inputs a drop write would have used in its transaction. */
export interface DeferredDropNotifications {
  readonly model: {
    readonly drop_id: string;
    readonly wave_id: string;
    readonly author_id: string;
    readonly drop_type: DropType;
    readonly reply_to: CreateOrUpdateDropModel['reply_to'];
    readonly mentioned_groups: CreateOrUpdateDropModel['mentioned_groups'];
    readonly parts: readonly {
      readonly quoted_drop: CreateOrUpdateDropModel['parts'][number]['quoted_drop'];
    }[];
  };
  readonly directly_mentioned_identity_ids: string[];
  readonly group_mention_notifications_enabled: boolean;
  readonly suppress_follower_notifications: boolean;
}

export interface DropWriteOutboxPayload {
  readonly v: typeof DROP_WRITE_OUTBOX_PAYLOAD_VERSION;
  readonly drop_type: DropType;
  readonly notifications: DeferredDropNotifications;
  /** A new drop: apply the DROP rollups and the wave metrics delta. */
  readonly record_created_drop: boolean;
}

export interface DropWriteResult {
  drop_id: string;
  replayed?: boolean;
  pending_push_notification_ids: number[];
  dm_unread_recipient_ids: string[];
  /** The post outbox row this write left, when the outbox was used. */
  outbox_id?: number | null;
}
