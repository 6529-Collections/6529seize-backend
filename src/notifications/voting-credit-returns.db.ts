import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_TABLE,
  VOTING_CREDIT_RELEASES_TABLE,
  VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE
} from '@/constants';
import { stableUuid } from '@/competitions/competition-id';
import type { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import type { VotingCreditReleaseEntity } from '@/entities/IVotingCreditRelease';
import type { VotingCreditsReturnedNotificationData } from './user-notification.types';

export const CREDIT_RETURN_BATCH_SIZE = 100;
type Recipient = { voter_profile_id: string; amount: number };
type Release = Omit<VotingCreditReleaseEntity, 'context'> & {
  context: VotingCreditReleaseEntity['context'] | string;
};

export class VotingCreditReturnsDb extends LazyDbAccessCompatibleService {
  private async query<T>(
    operation: string,
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<T[]> {
    const name = `${this.constructor.name}->${operation}`;
    ctx.timer?.start(name);
    try {
      return await this.db.execute<T>(sql, params, {
        wrappedConnection: ctx.connection
      });
    } finally {
      ctx.timer?.stop(name);
    }
  }

  /** Caller holds the competition lock. Never hydrate voters or publish here. */
  public async capture(
    params: {
      competitionId: string;
      entryId: string;
      reason: VotingCreditsReturnedNotificationData['reason'];
      actorId?: string | null;
      occurredAt: number;
    },
    ctx: RequestContext
  ): Promise<void> {
    if (!ctx.connection)
      throw new Error('Credit release requires a transaction');
    const values = {
      ...params,
      actorId: params.actorId ?? null,
      releaseId: stableUuid(
        params.competitionId,
        `credit-release:${params.entryId}`
      )
    };
    const inserted = await this.query(
      'captureRelease',
      `insert ignore into ${VOTING_CREDIT_RELEASES_TABLE}
       (id,context,after_profile_id,created_at,next_attempt_at,attempts,completed_at)
       select :releaseId,json_object('event_id',:releaseId,'reason',:reason,
         'wave_id',e.wave_id,'competition_id',c.id,'competition_title',c.title,
         'entry_id',e.id,'drop_id',e.drop_id,
         'submission_title',coalesce(nullif(trim(d.title),''),concat('Submission #',d.serial_no)),
         'credit_type',json_unquote(json_extract(c.voting_config,'$.credit_type')),
         'released_at',:occurredAt),'',:occurredAt,:occurredAt,0,null
       from ${COMPETITION_ENTRIES_TABLE} e
       join ${COMPETITIONS_TABLE} c on c.id=e.competition_id
       join ${DROPS_TABLE} d on d.id=e.drop_id
       where e.id=:entryId and e.competition_id=:competitionId and e.status='ACTIVE'
         and json_unquote(json_extract(c.voting_config,'$.credit_scope'))='WAVE'
         and (:reason='WIN' or e.submitter_id=:actorId)
         and exists(select 1 from ${COMPETITION_VOTES_TABLE} v
           where v.competition_id=c.id and v.entry_id=e.id and v.value<>0)`,
      values,
      ctx
    );
    // A replay must not repopulate snapshots already consumed by the worker.
    if (this.db.getAffectedRows(inserted) === 0) return;
    await this.query(
      'captureRecipients',
      `insert ignore into ${VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE}
       (release_id,voter_profile_id,amount)
       select r.id,v.voter_profile_id,abs(v.value)
       from ${VOTING_CREDIT_RELEASES_TABLE} r
       join ${COMPETITION_VOTES_TABLE} v on v.competition_id=:competitionId and v.entry_id=:entryId
       where r.id=:releaseId and r.completed_at is null and v.value<>0`,
      values,
      ctx
    );
  }

  /** Row lock, notification writes, push outbox and cursor commit together.
   * A crash simply rolls back this bounded page. Other jobs can skip its lock. */
  public async processBatch(
    deliver: (
      notifications: {
        recipientId: string;
        data: VotingCreditsReturnedNotificationData;
      }[],
      ctx: RequestContext
    ) => Promise<void>,
    now: number,
    ctx: RequestContext = {}
  ): Promise<boolean> {
    let releaseId: string | undefined;
    try {
      return await this.executeNativeQueriesInTransaction(
        async (connection) => {
          const tx = { ...ctx, connection };
          const [release] = await this.query<Release>(
            'claimRelease',
            `select * from ${VOTING_CREDIT_RELEASES_TABLE}
           where completed_at is null and next_attempt_at<=:now
           order by next_attempt_at,id limit 1 for update skip locked`,
            { now },
            tx
          );
          if (!release) return false;
          releaseId = release.id;
          const context: VotingCreditReleaseEntity['context'] =
            typeof release.context === 'string'
              ? JSON.parse(release.context)
              : release.context;
          const recipients = await this.query<Recipient>(
            'readRecipients',
            `select voter_profile_id,amount from ${VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE}
           where release_id=:id and voter_profile_id>:afterId
           order by voter_profile_id limit ${CREDIT_RETURN_BATCH_SIZE}`,
            { id: release.id, afterId: release.after_profile_id },
            tx
          );
          await deliver(
            recipients.map((recipient) => ({
              recipientId: recipient.voter_profile_id,
              data: { ...context, amount: Number(recipient.amount) }
            })),
            tx
          );
          if (recipients.length)
            await this.query(
              'deleteDeliveredRecipients',
              `delete from ${VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE} where release_id=:id and voter_profile_id in (:profileIds)`,
              {
                id: release.id,
                profileIds: recipients.map(
                  (recipient) => recipient.voter_profile_id
                )
              },
              tx
            );
          await this.query(
            'advanceRelease',
            `update ${VOTING_CREDIT_RELEASES_TABLE} set after_profile_id=:afterId,
           completed_at=:completedAt,attempts=0 where id=:id`,
            {
              id: release.id,
              afterId:
                recipients.at(-1)?.voter_profile_id ?? release.after_profile_id,
              completedAt:
                recipients.length < CREDIT_RETURN_BATCH_SIZE ? now : null
            },
            tx
          );
          return true;
        },
        { isolationLevel: 'READ COMMITTED' }
      );
    } catch (error) {
      if (releaseId)
        await this.query(
          'deferRelease',
          `update ${VOTING_CREDIT_RELEASES_TABLE} set next_attempt_at=:retryAt,
         attempts=attempts+1 where id=:id and completed_at is null`,
          { id: releaseId, retryAt: now + 60_000 },
          ctx
        );
      throw error;
    }
  }

  public async oldestPendingAt(ctx: RequestContext): Promise<number | null> {
    const [row] = await this.query<{ created_at: number | null }>(
      'oldestPendingAt',
      `select min(created_at) as created_at from ${VOTING_CREDIT_RELEASES_TABLE} where completed_at is null`,
      {},
      ctx
    );
    return row?.created_at == null ? null : Number(row.created_at);
  }
}

export const votingCreditReturnsDb = new VotingCreditReturnsDb(dbSupplier);
