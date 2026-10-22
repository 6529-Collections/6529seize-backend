import { randomUUID } from 'node:crypto';
import {
  VOTING_CREDIT_RELEASES_TABLE,
  VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE
} from '@/constants';
import { withCompetitionProfileMerge } from '@/competitions/competition-profile-merge';
import type { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import type { VotingCreditsReturnedNotificationData } from './user-notification.types';
import { VotingCreditReturnsDb } from './voting-credit-returns.db';
import { mergePendingVotingCreditRecipients } from './voting-credit-returns-profile-merge';

async function release(
  recipients: { profile: string; amount: number }[],
  after = '',
  ctx: RequestContext = {}
) {
  const id = randomUUID();
  const context: Omit<VotingCreditsReturnedNotificationData, 'amount'> = {
    event_id: id,
    reason: 'AUTHOR_DELETED',
    wave_id: 'hub',
    competition_id: randomUUID(),
    competition_title: 'Competition',
    entry_id: randomUUID(),
    drop_id: randomUUID(),
    submission_title: 'Saved title',
    credit_type: 'TDH',
    released_at: 1
  };
  await sqlExecutor.execute(
    `insert into ${VOTING_CREDIT_RELEASES_TABLE}
     (id,context,after_profile_id,created_at,next_attempt_at,attempts,completed_at)
     values (:id,:context,:after,1,1,0,null)`,
    { id, context: JSON.stringify(context), after },
    { wrappedConnection: ctx.connection }
  );
  await sqlExecutor.bulkInsert(
    VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE,
    recipients.map(({ profile, amount }) => ({
      release_id: id,
      voter_profile_id: profile,
      amount
    })),
    ['release_id', 'voter_profile_id', 'amount'],
    ctx
  );
  return id;
}

async function recipients(id: string, ctx: RequestContext = {}) {
  return sqlExecutor.execute<{ voter_profile_id: string; amount: number }>(
    `select voter_profile_id,amount from ${VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE}
     where release_id=:id order by voter_profile_id`,
    { id },
    { wrappedConnection: ctx.connection }
  );
}

describeWithSeed(
  'Pending voting credit returns during profile merge',
  [],
  () => {
    const repository = new VotingCreditReturnsDb(() => sqlExecutor);

    it('transfers deleted-entry recipients before existing notifications and combines pending allocations', async () => {
      const id = await release([
        { profile: 'z-source', amount: 7 },
        { profile: 'z2-source', amount: 5 },
        { profile: 'a-target', amount: 3 },
        { profile: 'other', amount: 2 }
      ]);
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        withCompetitionProfileMerge(
          sqlExecutor,
          ['z-source', 'a-target', 'z2-source'],
          'a-target',
          async () => {
            expect(await recipients(id, { connection })).toEqual([
              { voter_profile_id: 'a-target', amount: 15 },
              { voter_profile_id: 'other', amount: 2 }
            ]);
          },
          { connection }
        )
      );
      const delivered: {
        recipientId: string;
        amount: number;
        title: string;
      }[] = [];
      await repository.processBatch(async (batch) => {
        delivered.push(
          ...batch.map(({ recipientId, data }) => ({
            recipientId,
            amount: data.amount,
            title: data.submission_title
          }))
        );
      }, 1000);
      expect(delivered).toEqual([
        { recipientId: 'a-target', amount: 15, title: 'Saved title' },
        { recipientId: 'other', amount: 2, title: 'Saved title' }
      ]);
    });

    it('restarts partial-page progress without recreating any delivered allocation', async () => {
      const id = await release([
        { profile: 'a-target', amount: 3 },
        ...Array.from({ length: 99 }, (_, index) => ({
          profile: `v${String(index).padStart(3, '0')}`,
          amount: 1
        })),
        { profile: 'z-source', amount: 7 }
      ]);
      const delivered: { profile: string; amount: number }[] = [];
      const deliver = async (
        batch: {
          recipientId: string;
          data: VotingCreditsReturnedNotificationData;
        }[]
      ) => {
        delivered.push(
          ...batch.map(({ recipientId, data }) => ({
            profile: recipientId,
            amount: data.amount
          }))
        );
      };
      await repository.processBatch(deliver, 1000);
      expect(delivered).toHaveLength(100);
      expect(await recipients(id)).toEqual([
        { voter_profile_id: 'z-source', amount: 7 }
      ]);
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        withCompetitionProfileMerge(
          sqlExecutor,
          ['z-source'],
          'a-target',
          async () => undefined,
          { connection }
        )
      );
      await repository.processBatch(deliver, 1001);
      expect(delivered).toHaveLength(101);
      expect(delivered.filter(({ profile }) => profile === 'a-target')).toEqual(
        [
          { profile: 'a-target', amount: 3 },
          { profile: 'a-target', amount: 7 }
        ]
      );
      expect(delivered.reduce((total, item) => total + item.amount, 0)).toBe(
        109
      );
      expect(await repository.processBatch(deliver, 1002)).toBe(false);
    });

    it('rolls back recipient transfer and cursor changes if the profile merge fails', async () => {
      const original = [
        { voter_profile_id: 'b-target', amount: 2 },
        { voter_profile_id: 'z-source', amount: 5 }
      ];
      const id = await release(
        original.map(({ voter_profile_id, amount }) => ({
          profile: voter_profile_id,
          amount
        })),
        'a'
      );
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          withCompetitionProfileMerge(
            sqlExecutor,
            ['z-source'],
            'b-target',
            async () => {
              throw new Error('Profile merge failed');
            },
            { connection }
          )
        )
      ).rejects.toThrow('Profile merge failed');
      expect(await recipients(id)).toEqual(original);
      expect(
        await sqlExecutor.execute(
          `select after_profile_id from ${VOTING_CREDIT_RELEASES_TABLE} where id=:id`,
          { id }
        )
      ).toEqual([{ after_profile_id: 'a' }]);
    });

    it('includes releases committed after the consolidation transaction took its snapshot', async () => {
      let id = '';
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await sqlExecutor.execute(
            `select id from ${VOTING_CREDIT_RELEASES_TABLE}`,
            {},
            { wrappedConnection: connection }
          );
          id = await release([{ profile: 'source', amount: 500 }]);
          await withCompetitionProfileMerge(
            sqlExecutor,
            ['source'],
            'target',
            async () => undefined,
            { connection }
          );
        },
        { isolationLevel: 'REPEATABLE READ' }
      );
      expect(await recipients(id)).toEqual([
        { voter_profile_id: 'target', amount: 500 }
      ]);
    });

    it('includes this transaction’s uncommitted releases', async () => {
      let id = '';
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          id = await release([{ profile: 'source', amount: 500 }], '', {
            connection
          });
          await withCompetitionProfileMerge(
            sqlExecutor,
            ['source'],
            'target',
            async () => undefined,
            { connection }
          );
        }
      );
      expect(await recipients(id)).toEqual([
        { voter_profile_id: 'target', amount: 500 }
      ]);
    });

    it('rejects transfer without the enclosing profile merge transaction', async () => {
      await expect(
        mergePendingVotingCreditRecipients(
          sqlExecutor,
          ['source'],
          'target',
          {}
        )
      ).rejects.toThrow('requires a transaction');
    });
  }
);
