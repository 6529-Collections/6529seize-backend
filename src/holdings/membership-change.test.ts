import { transferReconciliationDb } from '@/transactions/transfer-reconciliation.db';
import { holdingsMembershipChanged } from './membership-change';

jest.mock('@/transactions/transfer-reconciliation.db', () => ({
  transferReconciliationDb: { enqueue: jest.fn() }
}));

const enqueue = jest.mocked(transferReconciliationDb.enqueue);
const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const connection = { connection: {} } as never;

describe('holdingsMembershipChanged', () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env };
  });

  afterAll(() => {
    process.env = env;
  });

  it('queues the wallets for owners and activity in the mirror transaction', async () => {
    process.env.FEATURE_HOLDINGS_MEMBERSHIP_QUEUE = 'true';
    const ctx = { connection };

    await holdingsMembershipChanged(
      { height: 7, wallets: [A.toUpperCase().replace('0X', '0x'), A, B] },
      ctx
    );

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith([A, B], ['owners', 'activity'], ctx);
  });

  it('only logs with the flag off', async () => {
    delete process.env.FEATURE_HOLDINGS_MEMBERSHIP_QUEUE;

    await holdingsMembershipChanged(
      { height: 7, wallets: [A] },
      { connection }
    );

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does nothing for an empty change', async () => {
    process.env.FEATURE_HOLDINGS_MEMBERSHIP_QUEUE = 'true';

    await holdingsMembershipChanged({ height: 7, wallets: [] }, { connection });

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses to run outside the transaction that writes the keys', async () => {
    process.env.FEATURE_HOLDINGS_MEMBERSHIP_QUEUE = 'true';

    await expect(
      holdingsMembershipChanged({ height: 7, wallets: [A] }, {})
    ).rejects.toThrow('transaction');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
