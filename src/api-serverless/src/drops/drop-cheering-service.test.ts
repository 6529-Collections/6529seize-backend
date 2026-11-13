jest.mock('@/competitions/competition-entry.repository', () => ({
  competitionEntryRepository: { findDropEntries: jest.fn() }
}));
jest.mock('@/competitions/legacy-competition-mutation', () => ({
  withLegacyPrimaryMutation: (
    _wave: string,
    _ctx: unknown,
    action: (primary: { id: string }) => unknown
  ) => action({ id: 'original' })
}));
jest.mock('@/api/api-helpers', () => ({
  giveReadReplicaTimeToCatchUp: jest.fn()
}));
import { competitionEntryRepository } from '@/competitions/competition-entry.repository';
import { DropCheeringService } from './drop-cheering.service';
import { DropType } from '@/entities/IDrop';
import { WriteBusyException } from '@/api/write-transaction-budget';

function fixture(type: DropType) {
  const drop = { id: 'drop', wave_id: 'hub', drop_type: type };
  const voteConnection = { vote: true };
  let transactionsEnded = 0;
  const db = {
    executeNativeQueriesInTransaction: async (
      action: (connection: object) => unknown
    ) => {
      const connection = transactionsEnded === 0 ? voteConnection : {};
      const result = await action(connection);
      transactionsEnded++;
      return result;
    },
    findDropById: jest.fn(async () => drop),
    findDropByIdWithEligibilityCheck: jest.fn(async () => drop)
  };
  const reactions = {
    addReaction: jest.fn(async () => ({ transactionsEnded }))
  };
  const votes = { execute: jest.fn(async () => true) };
  const quick = {
    findNextUndiscoveredDrop: jest.fn(async () => ({ id: 'next' }))
  };
  const ws = { notifyAboutDropRatingUpdate: jest.fn() };
  const reader = { findDropByIdOrThrow: jest.fn(async () => drop) };
  const service = new DropCheeringService(
    db as never,
    reactions as never,
    votes as never,
    quick as never,
    ws as never,
    reader as never
  );
  return {
    service,
    reactions,
    votes,
    ws,
    reader,
    voteConnection,
    ended: () => transactionsEnded
  };
}
const request = {
  drop_id: 'drop',
  rater_profile_id: 'voter',
  groupIdsUserIsEligibleFor: [],
  newCheers: 1
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(competitionEntryRepository.findDropEntries).mockResolvedValue([]);
});

it('retains ordinary chat reactions in the mixed cheering handler', async () => {
  const { service, reactions, votes } = fixture(DropType.CHAT);
  await service.updateCheers(request, {});
  expect(reactions.addReaction).toHaveBeenCalledWith(
    'drop',
    'voter',
    ':+1:',
    expect.anything()
  );
  expect(votes.execute).not.toHaveBeenCalled();
});
it("applies a chat rating's reaction after the vote transaction, on no connection of it", async () => {
  // The reaction path runs its own budgeted transaction; inside the vote
  // transaction it read the drop back with overlapping statements.
  const { service, reactions, ended } = fixture(DropType.CHAT);
  let endedWhenCalled = -1;
  reactions.addReaction.mockImplementation(async () => {
    endedWhenCalled = ended();
    return { transactionsEnded: endedWhenCalled };
  });
  await service.updateCheers(request, {});
  expect(endedWhenCalled).toBe(1);
  const ctx = (reactions.addReaction.mock.calls[0] as unknown[])[3] as {
    connection?: unknown;
  };
  expect(ctx.connection).toBeUndefined();
});
it('fails a chat rating whole when its reaction transaction is busy: nothing was written', async () => {
  // A chat rating writes nothing in the vote transaction (checks only); the
  // reaction is its only write. So a busy reaction leaves no partial state:
  // the request answers 503 + Retry-After and a retry is safe.
  const { service, reactions, votes, ws } = fixture(DropType.CHAT);
  const busy = new WriteBusyException();
  reactions.addReaction.mockRejectedValue(busy);
  await expect(service.updateCheers(request, {})).rejects.toBe(busy);
  expect(votes.execute).not.toHaveBeenCalled();
  expect(ws.notifyAboutDropRatingUpdate).not.toHaveBeenCalled();
});
it('never reads the drop inside the vote transaction', async () => {
  for (const type of [DropType.CHAT, DropType.PARTICIPATORY]) {
    const { service, reader, voteConnection } = fixture(type);
    await service.updateCheers(request, {});
    for (const call of reader.findDropByIdOrThrow.mock.calls as unknown[][])
      expect((call[1] as { connection?: unknown }).connection).not.toBe(
        voteConnection
      );
  }
});
it('dispatches original-primary entry cheers to the native compatible vote command', async () => {
  jest
    .mocked(competitionEntryRepository.findDropEntries)
    .mockResolvedValue([{ competition_id: 'original' }] as never);
  const { service, reactions, votes } = fixture(DropType.PARTICIPATORY);
  await service.updateCheers(request, {});
  expect(votes.execute).toHaveBeenCalledWith(
    expect.objectContaining({ drop_id: 'drop', wave_id: 'hub', votes: 1 }),
    expect.anything()
  );
  expect(reactions.addReaction).not.toHaveBeenCalled();
});
it('keeps sibling native entries protected even when an old wire projection classifies their content as chat', async () => {
  jest
    .mocked(competitionEntryRepository.findDropEntries)
    .mockResolvedValue([{ competition_id: 'sibling' }] as never);
  const { service, reactions, votes, ws } = fixture(DropType.CHAT);
  await expect(service.updateCheers(request, {})).rejects.toThrow(
    'Vote through the decision entry'
  );
  expect(reactions.addReaction).not.toHaveBeenCalled();
  expect(votes.execute).not.toHaveBeenCalled();
  expect(ws.notifyAboutDropRatingUpdate).not.toHaveBeenCalled();
});

describe('rating broadcast (waves plan 1.6)', () => {
  function coalescingFixture(
    behave: (
      send: (phase: 'leading' | 'trailing' | 'immediate') => Promise<void>
    ) => Promise<string>
  ) {
    const drop = { id: 'drop', wave_id: 'hub', drop_type: DropType.CHAT };
    const later = { ...drop, reactions: ['later'] };
    const transactions: unknown[] = [];
    const db = {
      executeNativeQueriesInTransaction: async (
        action: (connection: object) => unknown,
        options?: unknown
      ) => {
        transactions.push(options);
        return action({});
      },
      findDropById: jest.fn(async () => drop),
      findDropByIdWithEligibilityCheck: jest.fn(async () => drop)
    };
    const ws = { notifyAboutDropRatingUpdate: jest.fn() };
    const reader = {
      findDropByIdOrThrow: jest
        .fn()
        .mockResolvedValueOnce(drop)
        .mockResolvedValueOnce(later)
    };
    const coalescer = { broadcast: jest.fn(({ send }) => behave(send)) };
    const service = new DropCheeringService(
      db as never,
      { addReaction: jest.fn() } as never,
      { execute: jest.fn(async () => true) } as never,
      {
        findNextUndiscoveredDrop: jest.fn(async () => ({ id: 'next' }))
      } as never,
      ws as never,
      reader as never,
      coalescer as never
    );
    return { service, ws, coalescer, drop, later, transactions };
  }

  it('coalesces rating broadcasts per drop', async () => {
    const { service, ws, coalescer, drop } = coalescingFixture(async (send) => {
      await send('leading');
      return 'leading';
    });

    await service.updateCheers(request, {});

    expect(coalescer.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'RATING', dropId: 'drop' })
    );
    expect(ws.notifyAboutDropRatingUpdate).toHaveBeenCalledWith(drop, {});
  });

  it('reads the committed drop on the writer for each broadcast phase', async () => {
    const { service, ws, drop, later, transactions } = coalescingFixture(
      async (send) => {
        await send('leading');
        await send('trailing');
        return 'trailing';
      }
    );

    await service.updateCheers(request, {});

    expect(ws.notifyAboutDropRatingUpdate).toHaveBeenNthCalledWith(1, drop, {});
    expect(ws.notifyAboutDropRatingUpdate).toHaveBeenNthCalledWith(
      2,
      later,
      {}
    );
    // The vote transaction, then one read-committed writer read per phase.
    expect(transactions).toEqual([
      { isolationLevel: 'READ COMMITTED' },
      { isolationLevel: 'READ COMMITTED' },
      { isolationLevel: 'READ COMMITTED' }
    ]);
  });

  it('never hands the ended transaction connection to the broadcast', async () => {
    const { service, ws } = coalescingFixture(async (send) => {
      await send('trailing');
      return 'trailing';
    });
    const callerConnection = { connection: { ended: true } };

    await service.updateCheers(request, { connection: callerConnection });

    const broadcastCtx = ws.notifyAboutDropRatingUpdate.mock.calls[0][1];
    expect(broadcastCtx.connection).toBeUndefined();
  });

  it('does not fail a committed vote when the broadcast fails', async () => {
    const { service } = coalescingFixture(async () => {
      throw new Error('fan-out failed');
    });

    await expect(service.updateCheers(request, {})).resolves.toBeUndefined();
  });
});
