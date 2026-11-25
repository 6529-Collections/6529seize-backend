const enqueue = jest.fn();

jest.mock('@/transactions/transfer-reconciliation.db', () => ({
  transferReconciliationDb: { enqueue }
}));

import { MEMBERSHIP_CHANGE_HANDLERS, queueHoldings } from './membership-change';

describe('membership change handlers', () => {
  beforeEach(() => enqueue.mockReset());

  it('queues the wallets for the holdings loops in the given transaction', async () => {
    const connection = { tx: 1 };
    await queueHoldings(
      {
        height: 9,
        wallets: ['0xa', '0xb'],
        keysBefore: { '0xa': '0xa', '0xb': '0xb' },
        keysAfter: { '0xa': '0xa-0xb', '0xb': '0xa-0xb' }
      },
      { connection: connection as never }
    );
    expect(enqueue).toHaveBeenCalledWith(
      ['0xa', '0xb'],
      ['owners', 'activity'],
      { connection }
    );
  });

  it('runs the holdings handler by default', () => {
    expect(MEMBERSHIP_CHANGE_HANDLERS).toContain(queueHoldings);
  });
});
