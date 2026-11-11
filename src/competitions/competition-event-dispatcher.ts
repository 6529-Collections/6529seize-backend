import {
  artistArtworkNotifications,
  ArtistArtworkNotifications
} from '@/notifications/artist-artwork-notifications';
import {
  nativeCompetitionRuntimeRepository,
  NativeCompetitionRuntimeRepository,
  NativeCompetitionEvent,
  NativeCompetitionOutboxRecord
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
import {
  isActivated,
  sendIdentityPushNotificationsStrict
} from '@/api/push-notifications/push-notifications.service';
import {
  pushNotificationOutboxDb,
  PushNotificationOutboxDb
} from '@/notifications/push-notification-outbox.db';
import { deployerDropper, DeployerDropper } from '@/deployer-dropper';
import { enqueueClaimBuild } from '@/waves/claims-builder-publisher';
import { env } from '@/env';
import { RequestContext } from '@/request.context';
import { Logger } from '@/logging';
import { competitionDeliveryErrorCode } from '@/competitions/competition-delivery-diagnostics';

/** The most one dispatch pass spends delivering events. */
export const DISPATCH_BUDGET_MS = 240_000;
const DISPATCH_MAX_BATCHES = 10;

export class CompetitionEventDispatcher {
  private readonly logger = Logger.get(this.constructor.name);
  public constructor(
    private readonly outbox: Pick<
      NativeCompetitionRuntimeRepository,
      | 'claimOutbox'
      | 'claimPriorityOutbox'
      | 'acknowledgeOutbox'
      | 'retryOutbox'
      | 'deferOutbox'
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
    private readonly announcementWaves: () => string[],
    private readonly artworkAlerts: Pick<
      ArtistArtworkNotifications,
      'deliver'
    > = artistArtworkNotifications,
    private readonly pushOutbox: Pick<
      PushNotificationOutboxDb,
      'enqueueMany'
    > = pushNotificationOutboxDb
  ) {}

  /**
   * Delivers pending outbox events for up to `budgetMs` (at most four
   * minutes) and ten batches of 100. Decision results are claimed first,
   * then everything else oldest first. Claimed events left when the budget
   * runs out are released for the next pass.
   */
  public async dispatchPending(
    ctx: RequestContext = {},
    now = Date.now(),
    { budgetMs = DISPATCH_BUDGET_MS }: { budgetMs?: number } = {}
  ): Promise<void> {
    const deadline = Date.now() + Math.min(DISPATCH_BUDGET_MS, budgetMs);
    let batches = 0;
    for (const priority of [true, false]) {
      while (batches < DISPATCH_MAX_BATCHES && Date.now() < deadline) {
        batches++;
        const params = { now, limit: 100, leaseMs: 10 * 60_000 };
        const records = priority
          ? await this.outbox.claimPriorityOutbox(params, ctx)
          : await this.outbox.claimOutbox(params, ctx);
        await this.deliverClaimed(records, ctx, deadline);
        if (records.length < 100) break;
      }
    }
  }

  private async deliverClaimed(
    records: readonly NativeCompetitionOutboxRecord[],
    ctx: RequestContext,
    deadline: number
  ): Promise<void> {
    for (const record of records) {
      try {
        if (
          Date.now() >= deadline ||
          !(await this.dispatch(record.event, ctx, deadline))
        ) {
          await this.outbox.deferOutbox(
            record.id,
            record.lease_token,
            Date.now(),
            ctx
          );
          continue;
        }
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
  }

  public async dispatch(
    event: NativeCompetitionEvent,
    ctx: RequestContext,
    deadline = Date.now() + DISPATCH_BUDGET_MS
  ): Promise<boolean> {
    const context = await this.repository.getContext(event, ctx);
    // Draft IDs/configuration never leak to wave-wide subscriptions. Deleted
    // hubs are no longer deliverable; their outbox history remains for audit.
    if (
      !context ||
      context.published_at === null ||
      context.lifecycle === 'DRAFT' ||
      event.event_type === 'COMPETITION_CREATED'
    )
      return true;
    await this.sockets.notifyAboutCompetitionUpdate(
      event,
      context.visibility_group_id,
      ctx
    );
    // The shared transport owns delayed refresh repair. A throttled listener
    // must never replay this event's durable notifications or winner effects.
    if (event.event_type === 'COMPETITION_ENTRY_CREATED') {
      await this.handoffEntryPush(event, ctx);
    }
    if (
      !(await this.artworkAlerts.deliver(
        event,
        ctx,
        Math.min(deadline, Date.now() + 20_000)
      ))
    )
      return false;
    await this.notifyFollowers(event, context, ctx);
    if (event.event_type === 'COMPETITION_DECISION_COMPLETED')
      await this.deliverPrivilegedWinnerEffects(event, ctx);
    return true;
  }

  private async handoffEntryPush(
    event: NativeCompetitionEvent,
    ctx: RequestContext
  ): Promise<void> {
    const ids = event.data.pending_push_notification_ids;
    if (Array.isArray(ids)) {
      if (
        !ids.every(
          (id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0
        )
      )
        throw new Error('Invalid entry push handoff identifiers');
      if (event.data.artwork_alert_eligible === true) {
        // Artwork fan-out may span several passes. Persist this existing
        // entry handoff once as well, instead of sending it on every pass.
        await this.repository.applyEffect(
          event.event_id,
          'entry-push',
          async (tx) => {
            if (isActivated())
              await this.pushOutbox.enqueueMany(Array.from(new Set(ids)), tx);
            return ids;
          },
          ctx
        );
      } else {
        await this.push(ids);
      }
    }
  }

  private async notifyFollowers(
    event: NativeCompetitionEvent,
    context: CompetitionEventContext,
    ctx: RequestContext
  ): Promise<void> {
    if (
      event.event_type !== 'COMPETITION_DECISION_COMPLETED' ||
      !Array.isArray(event.data.winners) ||
      event.data.winners.length === 0
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
