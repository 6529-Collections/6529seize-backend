// The notification seed for the rebuild check: notifications for the second
// fixture profile, the notify probes' caller, written through today's
// notification writers and marked read through the mark-read path, as the
// API does. Two causes the indexes can derive again: the first fixture
// profile follows the second (the personal records) and rates it (the
// identity mirror). The follow and the rating rows themselves belong to the
// personal and identity seeds; this step writes only what the notifier
// writes when they happen. Not the other way round: the first profile mutes
// the second (the personal seed), so nothing from the second reaches it.
import { identityNotificationsDb } from '@/notifications/identity-notifications.db';
import { userNotifier } from '@/notifications/user.notifier';
import { IDENTITY_NOTIFICATIONS_TABLE } from '@/constants';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { PROBE_SINCE_MS } from '@/rebuild/manifests/probe-fixture';
import { probeProfileId } from '@/rebuild/run/probe-fixture.steps';
import { dbSupplier } from '@/sql-executor';

/** The caller the notify probes sign in as, and the profile that acts on it. */
export const NOTIFY_SEED_RECIPIENT = probeProfileId(2);
export const NOTIFY_SEED_ACTOR = probeProfileId(1);

/** The follow is read at a fixed time, inside the probe window. */
export const NOTIFY_SEED_READ_AT = PROBE_SINCE_MS + 86_400_000;

async function rowOf(cause: IdentityNotificationCause): Promise<number> {
  const row = await dbSupplier().oneOrNull<{ id: number }>(
    `select id from ${IDENTITY_NOTIFICATIONS_TABLE}
     where identity_id = :recipient and additional_identity_id = :actor
       and cause = :cause
     order by id limit 1`,
    { recipient: NOTIFY_SEED_RECIPIENT, actor: NOTIFY_SEED_ACTOR, cause }
  );
  if (!row) throw new Error(`The notifier wrote no ${cause} row`);
  return Number(row.id);
}

/**
 * Before the switch: the old writers' rows in identity_notifications. One
 * read (the follow), one unread (the rating). Running it again writes
 * nothing new.
 */
export async function seedNotifications(): Promise<void> {
  // The notifier writes only where it is switched on, as in production.
  process.env.USER_NOTIFIER_ACTIVATED = 'true';
  const existing = await dbSupplier().oneOrNull<{ n: number }>(
    `select count(*) as n from ${IDENTITY_NOTIFICATIONS_TABLE}
     where identity_id = :recipient and additional_identity_id = :actor`,
    { recipient: NOTIFY_SEED_RECIPIENT, actor: NOTIFY_SEED_ACTOR }
  );
  if (Number(existing?.n ?? 0) > 0) return;
  await userNotifier.notifyOfIdentitySubscription({
    subscriber_id: NOTIFY_SEED_ACTOR,
    subscribed_to: NOTIFY_SEED_RECIPIENT
  });
  await userNotifier.notifyOfIdentityRep({
    rater_id: NOTIFY_SEED_ACTOR,
    rated_id: NOTIFY_SEED_RECIPIENT,
    amount: 3,
    rater_rating: 3,
    total: 3,
    category: 'Probe'
  });
  await identityNotificationsDb.updateNotificationReadAt({
    id: await rowOf(IdentityNotificationCause.IDENTITY_SUBSCRIBED),
    identity_id: NOTIFY_SEED_RECIPIENT,
    readAt: NOTIFY_SEED_READ_AT
  });
  await rowOf(IdentityNotificationCause.IDENTITY_REP);
}
