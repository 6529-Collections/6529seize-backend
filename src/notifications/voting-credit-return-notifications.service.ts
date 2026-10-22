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

export class VotingCreditReturnNotificationsService {
  private readonly logger = Logger.get(this.constructor.name);

  public constructor(
    private readonly repository: Pick<
      VotingCreditReturnsDb,
      'processBatch' | 'oldestPendingAt'
    > = votingCreditReturnsDb
  ) {}

  public async processPending(ctx: RequestContext = {}): Promise<void> {
    if (process.env.USER_NOTIFIER_ACTIVATED !== 'true') return;
    // Bound both database pressure and runtime independently of recipient count.
    const deadline = Date.now() + 40_000;
    const oldest = await this.repository.oldestPendingAt(ctx);
    if (oldest !== null && Date.now() - oldest > 5 * 60_000)
      this.logger.warn('voting_credit_return_backlog', {
        oldest_pending_at: oldest
      });
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
}

export const votingCreditReturnNotificationsService =
  new VotingCreditReturnNotificationsService();
