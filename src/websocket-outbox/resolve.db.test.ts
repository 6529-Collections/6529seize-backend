import * as loopDb from '@/db';
import { DROPS_TABLE } from '@/constants';
import { setSqlExecutor, sqlExecutor } from '@/sql-executor';
import { resolveWebSocketEvent } from './resolve';

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
    await sqlExecutor.execute(`delete from ${DROPS_TABLE} where id = :id`, {
      id: dropId
    });
  });

  it('turns a real TypeORM BIGINT string into a numeric client cursor in a bound transaction', async () => {
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
