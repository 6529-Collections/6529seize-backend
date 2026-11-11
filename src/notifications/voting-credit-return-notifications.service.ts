import { wavesApiDb } from '@/api/waves/waves.api.db';
import { isActivated } from '@/api/push-notifications/push-notifications.service';
import { Logger } from '@/logging';
import type { RequestContext } from '@/request.context';
import { userNotifier } from './user.notifier';
import { pushNotificationOutboxDb } from './push-notification-outbox.db';
import {
  votingCreditReturnsDb,
  VotingCreditReturnsDb
} from './voting-credit-returns.db';
import { recordVotingCreditReturnMetrics } from './voting-credit-return-metrics';

export class VotingCreditReturnNotificationsService {
  private readonly logger = Logger.get(this.constructor.name);

  public constructor(
    private readonly repository: Pick<
      VotingCreditReturnsDb,
      'processBatch' | 'deliveryStats'
    > = votingCreditReturnsDb
  ) {}

  public async processPending(ctx: RequestContext = {}): Promise<void> {
    if (process.env.USER_NOTIFIER_ACTIVATED !== 'true') return;
    // Bound both database pressure and runtime independently of recipient count.
    const deadline = Date.now() + 40_000;
    await this.checkBacklog(ctx);
    for (let batch = 0; batch < 20 && Date.now() < deadline; batch++) {
      const worked = await this.repository.processBatch(
        async (notifications, tx) => {
          if (!notifications.length) return;
          const wave = await wavesApiDb.findWaveById(
            notifications[0].data.wave_id,
            tx.connection
          );
          // A deleted wave is no longer a deliverable notification destination.
          if (!wave) return;
          const ids = await userNotifier.notifyOfVotingCreditReturns(
            notifications,
            wave.visibility_group_id,
            tx
          );
          if (isActivated())
            await pushNotificationOutboxDb.enqueueMany(ids, tx);
        },
        Date.now(),
        ctx
      );
      if (!worked) return;
    }
  }

  private async checkBacklog(ctx: RequestContext): Promise<void> {
    try {
      const stats = await this.repository.deliveryStats(ctx);
      recordVotingCreditReturnMetrics(stats);
      if (
        stats.oldest_pending_at !== null &&
        Date.now() - stats.oldest_pending_at > 5 * 60_000
      )
        this.logger.warn('voting_credit_return_backlog', {
          oldest_pending_at: stats.oldest_pending_at
        });
    } catch (error) {
      this.logger.warn('voting_credit_return_backlog_check_failed', {
        error_name: error instanceof Error ? error.name : 'UNKNOWN'
      });
    }
  }
}

export const votingCreditReturnNotificationsService =
  new VotingCreditReturnNotificationsService();
