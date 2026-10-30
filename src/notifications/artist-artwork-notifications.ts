import {
  competitionEventRepository,
  CompetitionEventRepository
} from '@/competitions/competition-event.repository';
import { NativeCompetitionEvent } from '@/competitions/native-competition-runtime.repository';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { sendIdentityPushNotificationsStrict } from '@/api/push-notifications/push-notifications.service';
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
      'listRecipients' | 'isEnabled'
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
      'getGroupsUserIsEligibleFor'
    > = userGroupsService,
    private readonly profilePreferences: Pick<
      ProfilePreferencesDb,
      'get'
    > = profilePreferencesDb,
    private readonly notifier: Pick<
      UserNotifier,
      'notifyOfArtistArtwork'
    > = userNotifier,
    private readonly push: typeof sendIdentityPushNotificationsStrict = sendIdentityPushNotificationsStrict
  ) {}

  async deliver(
    event: NativeCompetitionEvent,
    ctx: RequestContext
  ): Promise<void> {
    // Qualification is frozen by the confirmed-create transaction. Old events,
    // edits and originally anonymous entries can never become retrospective alerts.
    if (
      event.event_type !== 'COMPETITION_ENTRY_CREATED' ||
      event.data.artwork_alert_eligible !== true
    )
      return;
    const submission = await this.submissions.find(event, ctx);
    if (!submission) return;
    let afterId = '';
    for (;;) {
      const recipients = await this.preferences.listRecipients(
        submission.artist_id,
        submission.submitted_at,
        afterId,
        ctx
      );
      if (!recipients.length) return;
      const pushIds: number[] = [];
      for (const recipientId of recipients) {
        const ids = await this.effects.applyEffect(
          event.event_id,
          `artwork:${recipientId}`,
          async (tx) => {
            const current = await this.submissions.find(event, tx);
            if (
              !current ||
              !(await this.preferences.isEnabled(
                { subscriberId: recipientId, artistId: current.artist_id },
                tx,
                current.submitted_at
              ))
            )
              return [];
            const groups = await this.groups.getGroupsUserIsEligibleFor(
              recipientId,
              tx.timer
            );
            if (
              !(await this.submissions.canReceive(
                current,
                recipientId,
                groups,
                tx
              ))
            )
              return [];
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
            const { visibility_group_id, ...data } = current;
            return this.notifier.notifyOfArtistArtwork(
              recipientId,
              data,
              visibility_group_id,
              tx
            );
          },
          ctx
        );
        pushIds.push(...ids);
      }
      // A failed enqueue retries the original IDs, never insertion.
      await this.push(pushIds);
      afterId = recipients[recipients.length - 1];
    }
  }
}

export const artistArtworkNotifications = new ArtistArtworkNotifications();
