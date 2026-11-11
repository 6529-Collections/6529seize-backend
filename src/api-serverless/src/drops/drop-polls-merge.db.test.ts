import 'reflect-metadata';
import { DROP_POLL_VOTES_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { DropPollsDb } from './drop-polls.db';

function vote(poll_id: string, option_no: number, voter_id: string) {
  return {
    poll_id,
    option_no,
    voter_id,
    wave_id: 'wave',
    drop_id: `drop-${poll_id}`,
    vote_time: 1
  };
}

describeWithSeed(
  'DropPollsDb.mergeOnProfileIdChange',
  {
    table: DROP_POLL_VOTES_TABLE,
    rows: [
      // Both voted in poll-a: the target's choice is kept.
      vote('poll-a', 1, 'source'),
      vote('poll-a', 2, 'target'),
      // Only the source voted in poll-b: its votes move.
      vote('poll-b', 1, 'source'),
      vote('poll-b', 3, 'source'),
      vote('poll-c', 1, 'other')
    ]
  },
  () => {
    const db = new DropPollsDb(() => sqlExecutor);

    async function votes() {
      return sqlExecutor.execute(
        `select poll_id, option_no, voter_id from ${DROP_POLL_VOTES_TABLE}
         order by poll_id, option_no, voter_id`
      );
    }

    it('keeps the target vote in shared polls and moves the rest', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        db.mergeOnProfileIdChange(
          { previous_id: 'source', new_id: 'target' },
          { connection }
        )
      );

      expect(await votes()).toEqual([
        { poll_id: 'poll-a', option_no: 2, voter_id: 'target' },
        { poll_id: 'poll-b', option_no: 1, voter_id: 'target' },
        { poll_id: 'poll-b', option_no: 3, voter_id: 'target' },
        { poll_id: 'poll-c', option_no: 1, voter_id: 'other' }
      ]);
    });

    it('changes nothing and leaves other voters free to vote for an identity without votes', async () => {
      const before = await votes();
      let release!: () => void;
      const finish = new Promise<void>((resolve) => {
        release = resolve;
      });
      let merged!: () => void;
      const mergedReady = new Promise<void>((resolve) => {
        merged = resolve;
      });
      const merge = sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await db.mergeOnProfileIdChange(
            { previous_id: 'no-handle', new_id: 'target' },
            { connection }
          );
          merged();
          await finish;
        }
      );
      await mergedReady;
      try {
        await sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            await sqlExecutor.execute(
              'set session innodb_lock_wait_timeout = 1',
              {},
              { wrappedConnection: connection }
            );
            try {
              // Without a voter index the merge would hold every vote row.
              await sqlExecutor.execute(
                `delete from ${DROP_POLL_VOTES_TABLE} where poll_id = 'poll-c' and voter_id = 'other'`,
                {},
                { wrappedConnection: connection }
              );
            } finally {
              await sqlExecutor.execute(
                'set session innodb_lock_wait_timeout = default',
                {},
                { wrappedConnection: connection }
              );
            }
          }
        );
      } finally {
        release();
        await merge;
      }

      expect(await votes()).toEqual(
        before.filter((row: { poll_id: string }) => row.poll_id !== 'poll-c')
      );
    });
  }
);
