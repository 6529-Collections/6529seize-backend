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

function fixture(type: DropType) {
  const drop = { id: 'drop', wave_id: 'hub', drop_type: type };
  const db = {
    executeNativeQueriesInTransaction: async (
      action: (connection: object) => unknown
    ) => action({}),
    findDropById: jest.fn(async () => drop),
    findDropByIdWithEligibilityCheck: jest.fn(async () => drop)
  };
  const reactions = { addReaction: jest.fn() };
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
  return { service, reactions, votes, ws };
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

  it('re-reads the committed drop on the writer for a trailing broadcast', async () => {
    const { service, ws, later, transactions } = coalescingFixture(
      async (send) => {
        await send('trailing');
        return 'trailing';
      }
    );

    await service.updateCheers(request, {});

    expect(ws.notifyAboutDropRatingUpdate).toHaveBeenCalledWith(later, {});
    expect(transactions).toContainEqual({ isolationLevel: 'READ COMMITTED' });
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
