import { DROP_POLL_OPTIONS_TABLE, DROP_POLLS_TABLE } from '@/constants';
import { DropPollsDb, CreateDropPollCommand } from './drop-polls.db';

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

  it('deletes only matching poll option conflicts before profile vote merge', async () => {
    const { service, execute } = createDb();

    await service.mergeOnProfileIdChange(
      { previous_id: 'source-profile', new_id: 'target-profile' },
      {}
    );

    expect(execute.mock.calls[0][0]).toContain(
      'target_votes.option_no = source_votes.option_no'
    );
  });
});
