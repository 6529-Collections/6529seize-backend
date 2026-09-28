import {
  nativeCompetitionRuntimeRepository,
  NativeCompetitionRuntimeRepository,
  NativeCompetitionEvent
} from './native-competition-runtime.repository';
import {
  competitionEventRepository,
  CompetitionEventRepository,
  CompetitionEventContext,
  NativeClaimContext
} from './competition-event.repository';
import {
  wsListenersNotifier,
  WsListenersNotifier
} from '@/api/ws/ws-listeners-notifier';
import { userNotifier, UserNotifier } from '@/notifications/user.notifier';
import { sendIdentityPushNotificationsStrict } from '@/api/push-notifications/push-notifications.service';
import { deployerDropper, DeployerDropper } from '@/deployer-dropper';
import { enqueueClaimBuild } from '@/waves/claims-builder-publisher';
import { env } from '@/env';
import { RequestContext } from '@/request.context';
import { Logger } from '@/logging';
import { competitionDeliveryErrorCode } from '@/competitions/competition-delivery-diagnostics';

const FOLLOWER_EVENTS = new Set([
  'COMPETITION_PUBLISHED',
  'COMPETITION_CANCELLED',
  'COMPETITION_ENDED',
  'COMPETITION_SCHEDULE_CHANGED',
  'COMPETITION_PAUSED',
  'COMPETITION_RESUMED',
  'COMPETITION_STARTED',
  'COMPETITION_DECISION_COMPLETED'
]);

export class CompetitionEventDispatcher {
  private readonly logger = Logger.get(this.constructor.name);
  public constructor(
    private readonly outbox: Pick<
      NativeCompetitionRuntimeRepository,
      'claimOutbox' | 'acknowledgeOutbox' | 'retryOutbox'
    >,
    private readonly repository: Pick<
      CompetitionEventRepository,
      | 'getContext'
      | 'listFollowers'
      | 'getEntrySubmitter'
      | 'applyEffect'
      | 'getPrivilegedWinners'
    >,
    private readonly sockets: Pick<
      WsListenersNotifier,
      'notifyAboutCompetitionUpdate'
    >,
    private readonly notifier: Pick<
      UserNotifier,
      'notifyOfCompetitionLifecycle'
    >,
    private readonly announcements: Pick<DeployerDropper, 'drop'>,
    private readonly publishClaim: (
      dropId: string,
      context?: NativeClaimContext
    ) => Promise<void>,
    private readonly push: typeof sendIdentityPushNotificationsStrict,
    private readonly announcementWaves: () => string[]
  ) {}

  public async dispatchPending(
    ctx: RequestContext = {},
    now = Date.now()
  ): Promise<void> {
    const startedAt = Date.now();
    for (
      let batch = 0;
      batch < 10 && Date.now() - startedAt < 240_000;
      batch++
    ) {
      const records = await this.outbox.claimOutbox(
        { now, limit: 100, leaseMs: 10 * 60_000 },
        ctx
      );
      if (!records.length) return;
      for (const record of records) {
        try {
          await this.dispatch(record.event, ctx);
          await this.outbox.acknowledgeOutbox(
            record.id,
            record.lease_token,
            Date.now(),
            ctx
          );
        } catch (error) {
          await this.outbox.retryOutbox(
            record.id,
            record.lease_token,
            Date.now(),
            ctx
          );
          this.logger.error('competition_event_delivery_failed', {
            event_id: record.id,
            competition_id: record.event.competition_id,
            attempts: record.attempts,
            error_code: competitionDeliveryErrorCode(error)
          });
        }
      }
      if (records.length < 100) return;
    }
  }

  public async dispatch(
    event: NativeCompetitionEvent,
    ctx: RequestContext
  ): Promise<void> {
    const context = await this.repository.getContext(event, ctx);
    // Draft IDs/configuration never leak to wave-wide subscriptions. Deleted
    // hubs are no longer deliverable; their outbox history remains for audit.
    if (
      !context ||
      context.published_at === null ||
      context.lifecycle === 'DRAFT' ||
      event.event_type === 'COMPETITION_CREATED'
    )
      return;
    await this.sockets.notifyAboutCompetitionUpdate(
      event,
      context.visibility_group_id,
      ctx
    );
    if (event.event_type === 'COMPETITION_ENTRY_CREATED') {
      const ids = event.data.pending_push_notification_ids;
      if (Array.isArray(ids)) {
        if (
          !ids.every(
            (id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0
          )
        )
          throw new Error('Invalid entry push handoff identifiers');
        await this.push(ids);
      }
    }
    await this.notifyFollowers(event, context, ctx);
    await this.notifyModeratedSubmitter(event, context, ctx);
    if (event.event_type === 'COMPETITION_DECISION_COMPLETED')
      await this.deliverPrivilegedWinnerEffects(event, ctx);
  }

  private async notifyFollowers(
    event: NativeCompetitionEvent,
    context: CompetitionEventContext,
    ctx: RequestContext
  ): Promise<void> {
    const changedFields = event.data.changed_fields;
    const scheduleChanged =
      event.event_type === 'COMPETITION_UPDATED' &&
      Array.isArray(changedFields) &&
      changedFields.some(
        (field) =>
          typeof field === 'string' &&
          [
            'participation',
            'voting',
            'decisions',
            'schedule',
            'participation_starts_at',
            'participation_ends_at',
            'voting_starts_at',
            'voting_ends_at'
          ].includes(field)
      );
    if (!FOLLOWER_EVENTS.has(event.event_type) && !scheduleChanged) return;
    if (
      event.event_type === 'COMPETITION_DECISION_COMPLETED' &&
      (!Array.isArray(event.data.winners) || event.data.winners.length === 0)
    )
      return;
    let afterId = '';
    for (;;) {
      const followers = await this.repository.listFollowers(
        event.wave_id,
        afterId,
        ctx
      );
      if (!followers.length) return;
      for (const recipientId of followers)
        await this.notifyRecipient(event, context, recipientId, ctx);
      afterId = followers[followers.length - 1];
    }
  }

  private async notifyModeratedSubmitter(
    event: NativeCompetitionEvent,
    context: CompetitionEventContext,
    ctx: RequestContext
  ): Promise<void> {
    if (
      !(
        event.event_type === 'COMPETITION_ENTRY_DISQUALIFIED' ||
        (event.event_type === 'COMPETITION_ENTRY_STATUS_CHANGED' &&
          event.data.status === 'DISQUALIFIED')
      ) ||
      !event.competition_entry_id
    )
      return;
    const recipient = await this.repository.getEntrySubmitter(
      event.competition_id,
      event.competition_entry_id,
      ctx
    );
    if (recipient) await this.notifyRecipient(event, context, recipient, ctx);
  }

  private async notifyRecipient(
    event: NativeCompetitionEvent,
    context: CompetitionEventContext,
    recipientId: string,
    ctx: RequestContext
  ): Promise<void> {
    const ids = await this.repository.applyEffect(
      event.event_id,
      `notify:${recipientId}`,
      (tx) =>
        this.notifier.notifyOfCompetitionLifecycle(
          recipientId,
          {
            event_id: event.event_id,
            event_type: event.event_type,
            wave_id: event.wave_id,
            competition_id: event.competition_id,
            competition_title: context.title,
            ...(event.competition_entry_id
              ? { entry_id: event.competition_entry_id }
              : {}),
            ...(event.drop_id ? { drop_id: event.drop_id } : {})
          },
          context.visibility_group_id,
          tx
        ),
      ctx
    );
    await this.push(ids);
  }

  private async deliverPrivilegedWinnerEffects(
    event: NativeCompetitionEvent,
    ctx: RequestContext
  ): Promise<void> {
    const decisionId = event.data.decision_id;
    if (typeof decisionId !== 'string')
      throw new Error('Decision event has no decision identity');
    const winners = await this.repository.getPrivilegedWinners(
      event.competition_id,
      decisionId,
      ctx
    );
    for (const winner of winners) {
      if (winner.rank === 1)
        await this.publishClaim(winner.drop_id, {
          competition_id: event.competition_id,
          competition_entry_id: winner.entry_id,
          decision_id: decisionId
        });
      const waves = this.announcementWaves();
      if (!waves.length) continue;
      const pendingIds = await this.repository.applyEffect(
        event.event_id,
        `announce:${winner.entry_id}`,
        async (tx) => {
          // Revalidate capability inside the effect's transaction before creating
          // a public announcement. Merely sharing Main Stage's wave grants none.
          const current = await this.repository.getPrivilegedWinners(
            event.competition_id,
            decisionId,
            tx
          );
          if (!current.some((row) => row.entry_id === winner.entry_id))
            return [];
          const url = `https://6529.io/waves/${encodeURIComponent(event.wave_id)}/competitions/${encodeURIComponent(event.competition_id)}?entry=${encodeURIComponent(winner.entry_id)}`;
          return this.announcements.drop(
            { waves, message: `🏆 New Main Stage Winner!\n${url}` },
            tx
          );
        },
        ctx
      );
      await this.push(pendingIds);
    }
  }
}

export const competitionEventDispatcher = new CompetitionEventDispatcher(
  nativeCompetitionRuntimeRepository,
  competitionEventRepository,
  wsListenersNotifier,
  userNotifier,
  deployerDropper,
  enqueueClaimBuild,
  sendIdentityPushNotificationsStrict,
  () => env.getStringArray('DEPLOYER_ANNOUNCEMENTS_WAVE_IDS')
);
