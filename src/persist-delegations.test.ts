import { USE_CASE_MINTING } from '@/constants';
import { DelegationEvent, EventType } from '@/entities/IDelegation';

// A data source whose repositories only exist inside transaction(), so any
// write made outside the transaction fails the test.
const mockTransactionalRepo = {
  delete: jest.fn(),
  save: jest.fn()
};
const mockTransaction = jest.fn(
  async (work: (manager: unknown) => Promise<unknown>) =>
    work({ getRepository: () => mockTransactionalRepo })
);

jest.mock('typeorm', () => {
  const actual = jest.requireActual('typeorm');
  class FakeDataSource {
    isInitialized = true;
    async initialize() {
      return this;
    }
    transaction(work: (manager: unknown) => Promise<unknown>) {
      return mockTransaction(work);
    }
    getRepository() {
      throw new Error('repository used outside a transaction');
    }
  }
  return { ...actual, DataSource: FakeDataSource };
});

import { connect, persistDelegations } from '@/db';

function event(overrides: Partial<DelegationEvent>): DelegationEvent {
  return {
    block: 10,
    type: EventType.REGISTER,
    wallet1: '0xcold',
    wallet2: '0xhot',
    collection: '0xcollection',
    use_case: USE_CASE_MINTING,
    ...overrides
  };
}

describe('persistDelegations', () => {
  beforeAll(async () => {
    await connect([]);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockTransactionalRepo.delete.mockResolvedValue({ raw: [], affected: 0 });
    mockTransactionalRepo.save.mockImplementation(async (rows) => rows);
  });

  it('writes the replay delete, registrations and revocations in one transaction', async () => {
    await persistDelegations(
      5,
      [event({ expiry: 1, all_tokens: false, token_id: 3 })],
      [event({ type: EventType.REVOKE, block: 12 })]
    );

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTransactionalRepo.delete).toHaveBeenCalledTimes(2);
    expect(mockTransactionalRepo.save).toHaveBeenCalledTimes(1);
  });

  it('rejects when a write fails, so the transaction rolls back', async () => {
    mockTransactionalRepo.save.mockRejectedValue(new Error('insert failed'));

    await expect(
      persistDelegations(
        5,
        [event({ expiry: 1 })],
        [event({ type: EventType.REVOKE, block: 12 })]
      )
    ).rejects.toThrow('insert failed');

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // Only the replay delete ran before the failure; no revocation followed.
    expect(mockTransactionalRepo.delete).toHaveBeenCalledTimes(1);
  });
});
