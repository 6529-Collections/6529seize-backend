import * as loopDb from '@/db';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_TABLE
} from '@/constants';
import { setSqlExecutor, sqlExecutor } from '@/sql-executor';
import { resolveWebSocketEvent } from './resolve';
import { anonymousCompetitionAuthor } from '@/competitions/competition-anonymity';
import { AuthenticationContext } from '@/auth-context';

jest.mock('@/api/ws/ws-connection.repository', () => ({
  wsConnectionRepository: {
    findWaveVisibilityGroupId: jest.fn().mockResolvedValue(null),
    getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast: jest
      .fn()
      .mockResolvedValue([{ connectionId: 'capable' }]),
    filterConnectionIdsByDeliveryMode: jest.fn().mockResolvedValue(['capable'])
  }
}));

const dropId = 'ws-outbox-typeorm-cursor';
const competitionId = 'ws-outbox-anonymous-competition';

describe('drop reference serialization through the worker database adapter', () => {
  beforeEach(async () => {
    await sqlExecutor.execute(
      `insert into ${DROPS_TABLE}
        (id, wave_id, author_id, created_at, parts_count)
       values (:id, 'test-wave', 'test-author', 1, 1)`,
      { id: dropId }
    );
  });

  afterEach(async () => {
    await sqlExecutor.execute(
      `delete from ${COMPETITION_ENTRIES_TABLE} where competition_id = :id`,
      { id: competitionId }
    );
    await sqlExecutor.execute(
      `delete from ${COMPETITIONS_TABLE} where id = :id`,
      { id: competitionId }
    );
    await sqlExecutor.execute(`delete from ${DROPS_TABLE} where id = :id`, {
      id: dropId
    });
  });

  it('preserves numeric cursors and entry privacy through the bound TypeORM adapter', async () => {
    // The usual Jest DB harness uses the API's numeric caster. Switch to the
    // same TypeORM adapter used by doInDbContext in websocketOutboundHandler.
    const observer = sqlExecutor;
    await loopDb.connect();
    try {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const raw = await sqlExecutor.oneOrNull<{ serial_no: string }>(
            `select serial_no from ${DROPS_TABLE} where id = :id`,
            { id: dropId },
            { wrappedConnection: connection }
          );
          expect(typeof raw?.serial_no).toBe('string');

          for (const updateType of [
            'DROP_UPDATE',
            'DROP_RATING_UPDATE',
            'DROP_REACTION_UPDATE'
          ] as const) {
            const jobs = await resolveWebSocketEvent(
              {
                type: 'drop',
                dropId,
                updateType,
                deliveryCapability: 'durable_updates_v1'
              },
              { connection }
            );
            expect(jobs).toHaveLength(1);
            const job = jobs[0];
            if (job.type !== 'delivery')
              throw new Error('Expected recipient job');
            expect(JSON.parse(job.message)).toEqual({
              type: 'DROP_UPDATE_REF',
              data: {
                drop_id: dropId,
                wave_id: 'test-wave',
                author_id: 'test-author',
                serial_no: Number(raw!.serial_no),
                update_type: updateType
              }
            });
            expect(job.deliveryCapability).toBe('durable_updates_v1');
          }

          await sqlExecutor.execute(
            `insert into ${COMPETITIONS_TABLE}
              (id, wave_id, type, lifecycle, title, participation_config,
               voting_config, decision_config, winner_config, outcome_config, created_at, updated_at)
             values (:id, 'test-wave', 'RANK', 'PUBLISHED', 'Anonymous',
               '{"anonymous_submissions":true}', '{}', '{}', '{}', '[]', 1, 1)`,
            { id: competitionId },
            { wrappedConnection: connection }
          );
          await sqlExecutor.execute(
            `insert into ${COMPETITION_ENTRIES_TABLE}
              (id, competition_id, wave_id, drop_id, submitter_id, status, config_version, submitted_at)
             values (:dropId, :competitionId, 'test-wave', :dropId, 'test-author', 'ACTIVE', 1, 1)`,
            { dropId, competitionId },
            { wrappedConnection: connection }
          );
          const ownerCtx = {
            connection,
            authenticationContext:
              AuthenticationContext.fromProfileId('test-author')
          };
          for (const wonAt of [null, 2]) {
            await sqlExecutor.execute(
              `update ${COMPETITION_ENTRIES_TABLE} set won_at = :wonAt where id = :dropId`,
              { wonAt, dropId },
              { wrappedConnection: connection }
            );
            for (const updateType of [
              'DROP_UPDATE',
              'DROP_RATING_UPDATE',
              'DROP_REACTION_UPDATE'
            ] as const) {
              const [job] = await resolveWebSocketEvent(
                {
                  type: 'drop',
                  dropId,
                  updateType,
                  reason: 'MEDIA_STATUS',
                  deliveryCapability: 'durable_updates_v1'
                },
                ownerCtx
              );
              if (job.type !== 'delivery')
                throw new Error('Expected recipient job');
              expect(JSON.parse(job.message).data).toEqual({
                drop_id: dropId,
                wave_id: 'test-wave',
                author_id:
                  wonAt === null
                    ? anonymousCompetitionAuthor({ id: 'test-author' }, dropId)
                        .id
                    : 'test-author',
                serial_no: Number(raw!.serial_no),
                update_type: updateType,
                reason: 'MEDIA_STATUS'
              });
              expect(job.deliveryCapability).toBe('durable_updates_v1');
            }
          }
        }
      );
    } finally {
      try {
        await loopDb.disconnect();
      } finally {
        setSqlExecutor(observer);
      }
    }
  });
});
