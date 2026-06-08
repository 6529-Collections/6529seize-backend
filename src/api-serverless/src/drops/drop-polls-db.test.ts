import { DROP_POLL_OPTIONS_TABLE, DROP_POLLS_TABLE } from '@/constants';
import { AuthenticationContext } from '@/auth-context';
import { PageSortDirection } from '@/api/page-request';
import {
  CreateDropPollCommand,
  DropPollsDb,
  DropPollsOrderBy
} from './drop-polls.db';

function createPollCommand(): CreateDropPollCommand {
  return {
    id: 'poll-1',
    wave_id: 'wave-1',
    drop_id: 'drop-1',
    closing_time: 2_000,
    multichoice: false,
    options: [
      { option_no: 1, option_string: 'First' },
      { option_no: 2, option_string: 'Second' }
    ]
  };
}

function createDb() {
  const execute = jest.fn().mockResolvedValue([]);
  const bulkInsert = jest.fn().mockResolvedValue(undefined);
  const transactionalConnection = { connection: { id: 'tx' } };
  const executeNativeQueriesInTransaction = jest.fn(async (fn) =>
    fn(transactionalConnection)
  );
  const service = new DropPollsDb(
    () =>
      ({
        execute,
        bulkInsert,
        executeNativeQueriesInTransaction
      }) as any
  );

  return {
    service,
    execute,
    bulkInsert,
    executeNativeQueriesInTransaction,
    transactionalConnection
  };
}

describe('DropPollsDb', () => {
  it('wraps poll and option inserts in a transaction when no caller connection is provided', async () => {
    const {
      service,
      execute,
      bulkInsert,
      executeNativeQueriesInTransaction,
      transactionalConnection
    } = createDb();
    const command = createPollCommand();

    await service.createPoll(command, {});

    expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining(`insert into ${DROP_POLLS_TABLE}`),
      command,
      { wrappedConnection: transactionalConnection }
    );
    expect(bulkInsert).toHaveBeenCalledWith(
      DROP_POLL_OPTIONS_TABLE,
      expect.arrayContaining([
        expect.objectContaining({
          poll_id: 'poll-1',
          option_no: 1,
          option_string: 'First'
        }),
        expect.objectContaining({
          poll_id: 'poll-1',
          option_no: 2,
          option_string: 'Second'
        })
      ]),
      ['poll_id', 'wave_id', 'drop_id', 'option_no', 'option_string'],
      { connection: transactionalConnection },
      { connection: transactionalConnection }
    );
  });

  it('reuses an existing caller connection for poll and option inserts', async () => {
    const { service, execute, bulkInsert, executeNativeQueriesInTransaction } =
      createDb();
    const command = createPollCommand();
    const existingConnection = { connection: { id: 'existing' } };

    await service.createPoll(command, { connection: existingConnection });

    expect(executeNativeQueriesInTransaction).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining(`insert into ${DROP_POLLS_TABLE}`),
      command,
      { wrappedConnection: existingConnection }
    );
    expect(bulkInsert).toHaveBeenCalledWith(
      DROP_POLL_OPTIONS_TABLE,
      expect.any(Array),
      ['poll_id', 'wave_id', 'drop_id', 'option_no', 'option_string'],
      { connection: existingConnection },
      { connection: existingConnection }
    );
  });

  it('maps authenticated poll vote option numbers when finding polls by drop ids', async () => {
    const { service, execute } = createDb();
    execute.mockResolvedValueOnce([
      {
        id: 'poll-1',
        wave_id: 'wave-1',
        drop_id: 'drop-1',
        closing_time: '2000',
        multichoice: 1,
        option_no: 1,
        option_string: 'First',
        votes: '5',
        voted_by_context_profile: 0
      },
      {
        id: 'poll-1',
        wave_id: 'wave-1',
        drop_id: 'drop-1',
        closing_time: '2000',
        multichoice: 1,
        option_no: 2,
        option_string: 'Second',
        votes: '3',
        voted_by_context_profile: 1
      }
    ]);

    const result = await service.findPollsByDropIds(['drop-1'], {
      authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
    });

    expect(result['drop-1']).toMatchObject({
      id: 'poll-1',
      voted: [2],
      options: [
        {
          option_no: 1,
          votes: 5,
          voted_by_context_profile: false
        },
        {
          option_no: 2,
          votes: 3,
          voted_by_context_profile: true
        }
      ]
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('viewer_votes.voter_id = :contextProfileId'),
      {
        dropIds: ['drop-1'],
        contextProfileId: 'viewer-1'
      },
      { wrappedConnection: undefined }
    );
  });

  it('maps authenticated poll vote option numbers when finding wave polls', async () => {
    const { service, execute } = createDb();
    execute
      .mockResolvedValueOnce([
        {
          id: 'poll-1',
          wave_id: 'wave-1',
          drop_id: 'drop-1',
          closing_time: '2000',
          multichoice: 1,
          created_at: '1000'
        }
      ])
      .mockResolvedValueOnce([
        {
          poll_id: 'poll-1',
          wave_id: 'wave-1',
          drop_id: 'drop-1',
          option_no: 2,
          option_string: 'Second',
          votes: '3',
          voted_by_context_profile: 1
        },
        {
          poll_id: 'poll-1',
          wave_id: 'wave-1',
          drop_id: 'drop-1',
          option_no: 1,
          option_string: 'First',
          votes: '5',
          voted_by_context_profile: 0
        }
      ]);

    const result = await service.findWavePolls(
      {
        waveId: 'wave-1',
        limit: 20,
        offset: 0,
        order: PageSortDirection.ASC,
        orderBy: DropPollsOrderBy.CREATED_AT,
        state: null,
        now: 1_500
      },
      {
        authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
      }
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'poll-1',
      voted: [2],
      options: [
        {
          option_no: 2,
          voted_by_context_profile: true
        },
        {
          option_no: 1,
          voted_by_context_profile: false
        }
      ]
    });
    expect(execute.mock.calls[1][1]).toEqual({
      pollIds: ['poll-1'],
      contextProfileId: 'viewer-1'
    });
  });

  it('drops source poll votes when the merge target already voted in the same poll', async () => {
    const { service, execute } = createDb();

    await service.mergeOnProfileIdChange(
      { previous_id: 'source-profile', new_id: 'target-profile' },
      {}
    );

    expect(execute.mock.calls[0][0]).toContain(
      'target_votes.poll_id = source_votes.poll_id'
    );
    expect(execute.mock.calls[0][0]).not.toContain('target_votes.option_no');
  });
});
