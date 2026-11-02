import {
  competitionEventRepository,
  CompetitionEventRepository
} from '@/competitions/competition-event.repository';
import { NativeCompetitionEvent } from '@/competitions/native-competition-runtime.repository';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { isActivated } from '@/api/push-notifications/push-notifications.service';
import {
  pushNotificationOutboxDb,
  PushNotificationOutboxDb
} from './push-notification-outbox.db';
import { DEFAULT_PROFILE_PREFERENCES } from '@/entities/IProfilePreferences';
import {
  profilePreferencesDb,
  ProfilePreferencesDb
} from '@/profile-preferences/profile-preferences.db';
import { isNotificationEnabled } from '@/profile-preferences/profile-notification-policy';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { RequestContext } from '@/request.context';
import {
  artistArtworkAlertsDb,
  ArtistArtworkAlertsDb
} from './artist-artwork-alerts.db';
import {
  artistArtworkSubmissionDb,
  ArtistArtworkSubmissionDb
} from './artist-artwork-submission.db';
import { userNotifier, UserNotifier } from './user.notifier';

export class ArtistArtworkNotifications {
  constructor(
    private readonly preferences: Pick<
      ArtistArtworkAlertsDb,
      'listPendingRecipients' | 'isEnabled'
    > = artistArtworkAlertsDb,
    private readonly submissions: Pick<
      ArtistArtworkSubmissionDb,
      'find' | 'canReceive'
    > = artistArtworkSubmissionDb,
    private readonly effects: Pick<
      CompetitionEventRepository,
      'applyEffect'
    > = competitionEventRepository,
    private readonly groups: Pick<
      UserGroupsService,
      'getGroupsUserIsEligibleForByIds'
    > = userGroupsService,
    private readonly profilePreferences: Pick<
      ProfilePreferencesDb,
      'get' | 'getMany'
    > = profilePreferencesDb,
    private readonly notifier: Pick<
      UserNotifier,
      'notifyOfArtistArtwork'
    > = userNotifier,
    private readonly pushOutbox: Pick<
      PushNotificationOutboxDb,
      'enqueueMany'
    > = pushNotificationOutboxDb
  ) {}

  async deliver(
    event: NativeCompetitionEvent,
    ctx: RequestContext,
    deadline = Date.now() + 20_000
  ): Promise<boolean> {
    // Qualification is frozen by the confirmed-create transaction. Old events,
    // edits and originally anonymous entries can never become retrospective alerts.
    if (
      event.event_type !== 'COMPETITION_ENTRY_CREATED' ||
      event.data.artwork_alert_eligible !== true
    )
      return true;
    if (Date.now() >= deadline) return false;
    const submission = await this.submissions.find(event, ctx);
    if (!submission) return true;
    const recipients = await this.preferences.listPendingRecipients(
      event.event_id,
      submission.entry_id,
      ctx
    );
    if (!recipients.length) return true;
    const groupIds = Array.from(
      new Set(
        [
          submission.visibility_group_id,
          submission.parent_visibility_group_id
        ].filter((id): id is string => id !== null)
      )
    );
    const preferences = groupIds.length
      ? await this.profilePreferences.getMany(recipients, ctx.connection)
      : new Map();
    for (const recipientId of recipients) {
      if (Date.now() >= deadline) return false;
      const enabled = isNotificationEnabled(
        IdentityNotificationCause.ARTIST_ARTWORK_SUBMITTED,
        preferences.get(recipientId) ?? DEFAULT_PROFILE_PREFERENCES
      );
      // Membership can involve Redis and multiple queries. Resolve only the
      // wave/parent groups, before taking the receipt or preference row locks.
      const groups =
        enabled && groupIds.length
          ? await this.groups.getGroupsUserIsEligibleForByIds(
              recipientId,
              groupIds,
              ctx.timer
            )
          : [];
      if (Date.now() >= deadline) return false;
      await this.effects.applyEffect(
        event.event_id,
        `artwork:${recipientId}`,
        (tx) =>
          this.notifyRecipient(
            event,
            recipientId,
            groupIds,
            groups,
            enabled,
            tx
          ),
        ctx
      );
    }
    return (
      (
        await this.preferences.listPendingRecipients(
          event.event_id,
          submission.entry_id,
          ctx
        )
      ).length === 0
    );
  }

  private async notifyRecipient(
    event: NativeCompetitionEvent,
    recipientId: string,
    groupIds: string[],
    groups: string[],
    enabled: boolean,
    tx: RequestContext
  ): Promise<number[]> {
    const profilePreferences = await this.profilePreferences.get(
      recipientId,
      tx.connection
    );
    if (
      !isNotificationEnabled(
        IdentityNotificationCause.ARTIST_ARTWORK_SUBMITTED,
        profilePreferences
      )
    )
      return [];
    // A replica read is only a cost-saving hint. A newly enabled policy
    // must be retried with group eligibility, never terminally skipped.
    if (!enabled && groupIds.length) {
      throw new Error(
        'Artwork notification preferences changed during delivery'
      );
    }
    const current = await this.submissions.find(event, tx);
    if (
      !current ||
      !(await this.preferences.isEnabled(
        {
          subscriberId: recipientId,
          artistId: current.artist_id,
          submittedAt: current.submitted_at
        },
        tx
      ))
    )
      return [];
    if (
      [current.visibility_group_id, current.parent_visibility_group_id].some(
        (id) => id !== null && !groupIds.includes(id)
      )
    ) {
      throw new Error('Artwork visibility changed during delivery');
    }
    if (!(await this.submissions.canReceive(current, recipientId, groups, tx)))
      return [];
    const { visibility_group_id, parent_visibility_group_id, ...data } =
      current;
    const ids = await this.notifier.notifyOfArtistArtwork(
      recipientId,
      data,
      visibility_group_id,
      tx
    );
    // Persist the push handoff with the notification and receipt. A
    // resumed batch can then skip completed recipients without losing pushes.
    if (isActivated()) await this.pushOutbox.enqueueMany(ids, tx);
    return ids;
  }
}

export const artistArtworkNotifications = new ArtistArtworkNotifications();
