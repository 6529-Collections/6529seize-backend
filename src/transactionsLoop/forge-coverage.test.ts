import { handler } from './index';
import { checkpointTransactionScan } from '@/transactions/transaction-scan-checkpoint';
import { MEMES_CONTRACT } from '@/constants';
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));
jest.mock('@/secrets', () => ({
  doInDbContext: (fn: () => Promise<void>) => fn()
}));
jest.mock('@/ethereum-rpc/ethereum-rpc-provider', () => ({
  getEthereumRpcProvider: jest.fn(() => ({}))
}));
jest.mock('@/transactions/transactions-discovery.service', () => ({
  transactionsDiscoveryService: { getAndSaveTransactionsForContract: jest.fn() }
}));
jest.mock('@/transactions/transaction-scan-checkpoint', () => ({
  checkpointTransactionScan: jest.fn()
}));
const old = { ...process.env };
beforeEach(() => {
  process.env.DROP_FORGE_STAGE = 'prod';
  process.env.DROP_FORGE_AUTOMATION_ENABLED = 'false';
  process.env.TRANSACTIONS_CONTRACT_ADDRESS = MEMES_CONTRACT;
  delete process.env.TRANSACTIONS_LOOP_START_BLOCK;
  delete process.env.TRANSACTIONS_LOOP_END_BLOCK;
  jest.clearAllMocks();
});
afterEach(() => {
  process.env = { ...old };
});
it('maintains mainnet coverage for signed-intent reconciliation with execution Off', async () => {
  await handler({}, {} as never, jest.fn());
  expect(checkpointTransactionScan).toHaveBeenCalledWith(
    1,
    MEMES_CONTRACT,
    expect.anything(),
    expect.any(Function)
  );
});
it.each(['staging', 'historical', 'other-creator'])(
  'does not certify unrelated %s indexing',
  async (mode) => {
    if (mode === 'staging') process.env.DROP_FORGE_STAGE = 'staging';
    if (mode === 'historical')
      process.env.TRANSACTIONS_LOOP_START_BLOCK = '100';
    if (mode === 'other-creator')
      process.env.TRANSACTIONS_CONTRACT_ADDRESS =
        '0x1111111111111111111111111111111111111111';
    await handler({}, {} as never, jest.fn());
    expect(checkpointTransactionScan).not.toHaveBeenCalled();
  }
);
