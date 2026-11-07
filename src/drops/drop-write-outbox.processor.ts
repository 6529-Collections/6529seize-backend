import { randomUUID } from 'node:crypto';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { dbSupplier, SqlExecutor } from '@/sql-executor';
import {
  isActivated as isPushActivated,
  sendIdentityPushNotificationsStrict
} from '@/api/push-notifications/push-notifications.service';
import {
  pushNotificationOutboxDb,
  PushNotificationOutboxDb
} from '@/notifications/push-notification-outbox.db';
import {
  waveScoreService,
  WaveScoreDirtyRefreshReason
} from '@/api/waves/wave-score.service';
import {
  dropWriteOutboxDb,
  DropWriteOutboxDb,
  DropWriteOutboxRow
} from './drop-write-outbox.db';
import {
  DROP_WRITE_OUTBOX_PAYLOAD_VERSION,
  DropWriteOutboxPayload
} from './drop-write-outbox.types';
import {
  createOrUpdateDrop,
  CreateOrUpdateDropUseCase
} from './create-or-update-drop.use-case';

/** How long a claim holds before the sweeper may take the row over. */
export const DROP_WRITE_OUTBOX_LEASE_MS = 60_000;

export class DropWriteOutboxClaimLostError extends Error {
  constructor(id: number) {
    super(`Post outbox row ${id} was claimed by another processor`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'DropWriteOutboxClaimLostError';
  }
}

export type DropWriteOutboxOutcome =
  | 'processed'
  | 'already_done_or_claimed'
  | 'claim_lost';

function isPayload(value: unknown): value is DropWriteOutboxPayload {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { v?: unknown }).v === DROP_WRITE_OUTBOX_PAYLOAD_VERSION &&
    typeof (value as { notifications?: unknown }).notifications === 'object'
  );
}

/**
 * Runs one post outbox row (waves plan 1.8), at least once and with effects
 * exactly once:
 *
 * 1. Claim the row in one statement (a lease with a fencing token). A row
 *    that is gone or leased elsewhere is a no-op, so repeated SQS deliveries
 *    and the sweeper overlapping the worker do nothing twice.
 * 2. In one transaction: the notifications, push rows, DROP rollups, wave
 *    metrics delta and score dirty mark, then delete the row with the token.
 *    If the token no longer matches (the lease expired and another processor
 *    took over), the transaction rolls back and none of it happened.
 * 3. After commit, publish the pushes at once; the per-minute push publisher
 *    sends any that this step could not.
 *
 * A crash anywhere before the commit leaves the row for the sweeper once the
 * lease expires.
 */
export class DropWriteOutboxProcessor {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly outboxDb: DropWriteOutboxDb,
    private readonly useCase: () => Pick<
      CreateOrUpdateDropUseCase,
      'applyDropWriteOutbox'
    >,
    private readonly pushOutbox: Pick<
      PushNotificationOutboxDb,
      'enqueueMany' | 'publishIds'
    >,
    private readonly db: () => Pick<
      SqlExecutor,
      'executeNativeQueriesInTransaction'
    > = dbSupplier,
    private readonly leaseMs: number = DROP_WRITE_OUTBOX_LEASE_MS,
    private readonly pushEnabled: () => boolean = isPushActivated,
    private readonly sendPush: (
      ids: number[]
    ) => Promise<void> = sendIdentityPushNotificationsStrict
  ) {}

  async process(
    outboxId: number,
    ctx: RequestContext = {}
  ): Promise<DropWriteOutboxOutcome> {
    const token = randomUUID();
    if (
      !(await this.outboxDb.claim(
        { id: outboxId, token, leaseMs: this.leaseMs },
        ctx
      ))
    ) {
      return 'already_done_or_claimed';
    }
    let pushIds: number[];
    let row: DropWriteOutboxRow | null = null;
    try {
      ({ pushIds, row } = await this.db().executeNativeQueriesInTransaction(
        async (connection) => {
          const txCtx = { ...ctx, connection };
          const claimed = await this.outboxDb.findById(outboxId, txCtx);
          if (!claimed) throw new DropWriteOutboxClaimLostError(outboxId);
          if (!isPayload(claimed.payload)) {
            throw new Error(
              `Post outbox row ${outboxId} has an unknown payload version`
            );
          }
          const notificationIds = await this.useCase().applyDropWriteOutbox(
            { ...claimed, payload: claimed.payload },
            txCtx
          );
          const pushable = this.pushEnabled() ? notificationIds : [];
          await this.pushOutbox.enqueueMany(pushable, txCtx);
          if (
            !(await this.outboxDb.deleteClaimed({ id: outboxId, token }, txCtx))
          ) {
            throw new DropWriteOutboxClaimLostError(outboxId);
          }
          return { pushIds: pushable, row: claimed };
        },
        { isolationLevel: 'READ COMMITTED' }
      ));
    } catch (error) {
      if (error instanceof DropWriteOutboxClaimLostError) {
        return 'claim_lost';
      }
      await this.outboxDb
        .releaseFailed(
          {
            id: outboxId,
            token,
            error: error instanceof Error ? error.message : String(error)
          },
          ctx
        )
        .catch(() => undefined);
      throw error;
    }
    await this.afterCommit(row!, pushIds, ctx);
    return 'processed';
  }

  private async afterCommit(
    row: DropWriteOutboxRow,
    pushIds: number[],
    ctx: RequestContext
  ): Promise<void> {
    try {
      await this.pushOutbox.publishIds(pushIds, this.sendPush);
    } catch (error) {
      // The rows stay in the push outbox; its per-minute publisher sends them.
      this.logger.warn(
        `Post outbox ${row.id}: immediate push publication deferred: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    try {
      await waveScoreService.requestWaveScoreRefreshBestEffort(
        [row.wave_id],
        WaveScoreDirtyRefreshReason.DROP_CHANGED,
        ctx
      );
    } catch (error) {
      // The work has committed; the dirty mark already queues the refresh.
      this.logger.warn(
        `Post outbox ${row.id}: wave score refresh request failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

export const dropWriteOutboxProcessor = new DropWriteOutboxProcessor(
  dropWriteOutboxDb,
  () => createOrUpdateDrop,
  pushNotificationOutboxDb
);
