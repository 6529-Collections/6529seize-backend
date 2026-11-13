import { enqueueWalletRepair, repairWallets } from './repair-wallets';
import { transferReconciliationDb } from '@/transactions/transfer-reconciliation.db';
jest.mock('@/transactions/transfer-reconciliation.db', () => ({
  transferReconciliationDb: { enqueueRepair: jest.fn() }
}));
const wallet = '0x1111111111111111111111111111111111111111';
it('leaves scheduled invocations on their normal path', () => {
  expect(repairWallets({ source: 'aws.events' })).toBeNull();
  expect(repairWallets(undefined)).toBeNull();
});
it.each([
  { action: 'unknown' },
  { action: 'repair-wallets', wallets: [] },
  { action: 'repair-wallets', wallets: ['invalid'] },
  { action: 'repair-wallets', wallets: [null] },
  {
    action: 'repair-wallets',
    wallets: ['0x0000000000000000000000000000000000000000']
  },
  { action: 'repair-wallets', wallets: Array(101).fill(wallet) }
])('rejects invalid maintenance requests', (event) =>
  expect(() => repairWallets(event)).toThrow()
);
it('deduplicates wallets and queues repair without running a calculation', async () => {
  const wallets = repairWallets({
    action: 'repair-wallets',
    wallets: [wallet, wallet]
  })!;
  expect(wallets).toEqual([wallet]);
  expect(await enqueueWalletRepair(wallets)).toEqual({
    action: 'repair-wallets',
    status: 'queued',
    wallets: [wallet]
  });
  expect(transferReconciliationDb.enqueueRepair).toHaveBeenCalledWith([wallet]);
});
