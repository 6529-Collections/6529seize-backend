import type { NewIdentityNotification } from '@/notifications/identity-notifications.db';

/** One notification a rule derives, with the time it shows. */
export interface DerivedNotification extends NewIdentityNotification {
  readonly created_at: number;
}

/**
 * Everything one rule derives from one source. `rows` is the complete set
 * for (family, ref): applying a group again with fewer rows removes the
 * missing ones (an edit that drops a mention), and applying the same group
 * twice changes nothing.
 */
export interface DerivedGroup {
  /** The rule family, such as `rating`, `vote` or `drop`. */
  readonly family: string;
  /** The source within the family: an event id, a transaction id, an entity id. */
  readonly ref: string;
  readonly rows: readonly DerivedNotification[];
}
