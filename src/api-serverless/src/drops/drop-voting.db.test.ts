import {
  DropVotingDb,
  buildMergedDropRealVoteHistoryStates
} from './drop-voting.db';

describe('buildMergedDropRealVoteHistoryStates', () => {
  it('sums overlapping voters across both merged nominations', () => {
    expect(
      buildMergedDropRealVoteHistoryStates({
        targetDropId: 'target-drop',
        waveId: 'wave-1',
        voteChanges: [
          {
            id: 1,
            original_drop_id: 'target-drop',
            voter_id: 'voter-1',
            vote: 5,
            timestamp: 100
          },
          {
            id: 2,
            original_drop_id: 'source-drop',
            voter_id: 'voter-1',
            vote: 3,
            timestamp: 200
          },
          {
            id: 3,
            original_drop_id: 'target-drop',
            voter_id: 'voter-1',
            vote: 6,
            timestamp: 300
          }
        ]
      })
    ).toEqual([
      {
        drop_id: 'target-drop',
        wave_id: 'wave-1',
        timestamp: 100,
        vote: 5
      },
      {
        drop_id: 'target-drop',
        wave_id: 'wave-1',
        timestamp: 200,
        vote: 8
      },
      {
        drop_id: 'target-drop',
        wave_id: 'wave-1',
        timestamp: 300,
        vote: 9
      }
    ]);
  });

  it('collapses same-timestamp changes to the final total at that timestamp', () => {
    expect(
      buildMergedDropRealVoteHistoryStates({
        targetDropId: 'target-drop',
        waveId: 'wave-1',
        voteChanges: [
          {
            id: 1,
            original_drop_id: 'target-drop',
            voter_id: 'voter-1',
            vote: 5,
            timestamp: 100
          },
          {
            id: 2,
            original_drop_id: 'source-drop',
            voter_id: 'voter-1',
            vote: 3,
            timestamp: 100
          }
        ]
      })
    ).toEqual([
      {
        drop_id: 'target-drop',
        wave_id: 'wave-1',
        timestamp: 100,
        vote: 8
      }
    ]);
  });
});

describe('DropVotingDb.mergeDropVoteState', () => {
  function createDb() {
    const execute = jest.fn().mockResolvedValue([]);
    const oneOrNull = jest.fn().mockResolvedValue(null);
    const transactionalConnection = { connection: { id: 'tx' } };
    const executeNativeQueriesInTransaction = jest.fn(async (fn) =>
      fn(transactionalConnection)
    );
    const db = {
      execute,
      oneOrNull,
      executeNativeQueriesInTransaction
    };
    return {
      service: new DropVotingDb(() => db as any),
      execute,
      oneOrNull,
      executeNativeQueriesInTransaction,
      transactionalConnection
    };
  }

  it('wraps merge in a transaction when no connection is provided', async () => {
    const {
      service,
      execute,
      oneOrNull,
      executeNativeQueriesInTransaction,
      transactionalConnection
    } = createDb();

    await service.mergeDropVoteState(
      {
        sourceDropId: 'source-drop',
        targetDropId: 'target-drop',
        waveId: 'wave-1'
      },
      {}
    );

    expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
    expect(oneOrNull).toHaveBeenCalled();
    for (const call of [...execute.mock.calls, ...oneOrNull.mock.calls]) {
      expect(call[2]).toEqual({ wrappedConnection: transactionalConnection });
    }
  });

  it('reuses the caller connection when one is already provided', async () => {
    const { service, execute, oneOrNull, executeNativeQueriesInTransaction } =
      createDb();
    const existingConnection = { connection: { id: 'existing' } };

    await service.mergeDropVoteState(
      {
        sourceDropId: 'source-drop',
        targetDropId: 'target-drop',
        waveId: 'wave-1'
      },
      { connection: existingConnection }
    );

    expect(executeNativeQueriesInTransaction).not.toHaveBeenCalled();
    expect(oneOrNull).toHaveBeenCalled();
    for (const call of [...execute.mock.calls, ...oneOrNull.mock.calls]) {
      expect(call[2]).toEqual({ wrappedConnection: existingConnection });
    }
  });
});
