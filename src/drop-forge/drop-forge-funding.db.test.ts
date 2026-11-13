import { JsonRpcProvider } from 'ethers';
import { DROP_FORGE_FUNDING_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { clearDropForgeTestTables } from '@/drop-forge/drop-forge.db-test-fixtures';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';
import * as rpc from '@/ethereum-rpc/ethereum-rpc-provider';
import * as notifier from '@/drop-forge/drop-forge.notifier';
import { EthereumLaunchChain } from '@/drop-forge/drop-forge.chain';
import {
  registerForgeFunding,
  processForgeFunding
} from '@/drop-forge/drop-forge.funding';
const sender = '0x' + '66'.repeat(20);
const hash = '0x' + 'ab'.repeat(32);
const replacement = '0x' + 'cd'.repeat(32);
const id = `funding:${testConfig.chainId}:${sender}:7`;
let transaction: {
  from: string;
  to: string;
  value: bigint;
  data: string;
  chainId: bigint;
  nonce: number;
};
beforeEach(async () => {
  jest.clearAllMocks();
  await clearDropForgeTestTables();
  transaction = {
    from: sender,
    to: testConfig.signer,
    value: BigInt(1000),
    data: '0x',
    chainId: BigInt(testConfig.chainId),
    nonce: 7
  };
  jest.spyOn(rpc, 'getEthereumRpcProvider').mockReturnValue({
    getTransaction: async () => transaction
  } as unknown as JsonRpcProvider);
  jest.spyOn(notifier, 'postForgeReport').mockResolvedValue({
    drop_id: 'reported',
    pending_push_notification_ids: []
  });
  jest.spyOn(EthereumLaunchChain.prototype, 'receipt').mockResolvedValue({
    status: 1,
    blockNumber: 100,
    blockHash: 'canonical',
    confirmations: 12
  });
});
it('records an authenticated deposit and reports it once across duplicate delivery', async () => {
  await registerForgeFunding(testConfig, sender, hash);
  await processForgeFunding(testConfig, { id, revision: 0 });
  await processForgeFunding(testConfig, { id, revision: 0 });
  expect(notifier.postForgeReport).toHaveBeenCalledTimes(1);
  expect(
    await sqlExecutor.oneOrNull<{ drop_id: string }>(
      `SELECT drop_id FROM ${DROP_FORGE_FUNDING_TABLE} WHERE id = :id`,
      { id }
    )
  ).toMatchObject({ drop_id: 'reported' });
});
it('waits for canonical confirmations and retains reporting after a failed commit', async () => {
  await registerForgeFunding(testConfig, sender, hash);
  jest
    .mocked(EthereumLaunchChain.prototype.receipt)
    .mockResolvedValueOnce(null);
  await processForgeFunding(testConfig, { id, revision: 0 });
  expect(notifier.postForgeReport).not.toHaveBeenCalled();
  jest
    .mocked(notifier.postForgeReport)
    .mockRejectedValueOnce(new Error('wave unavailable'));
  await expect(
    processForgeFunding(testConfig, { id, revision: 0 })
  ).rejects.toThrow('wave unavailable');
  expect(
    (await sqlExecutor.oneOrNull<{ drop_id: string | null }>(
      `SELECT drop_id FROM ${DROP_FORGE_FUNDING_TABLE} WHERE id = :id`,
      { id }
    ))!.drop_id
  ).toBeNull();
  await processForgeFunding(testConfig, { id, revision: 0 });
  expect(notifier.postForgeReport).toHaveBeenCalledTimes(2);
});
it('tracks same-nonce replacements and reports the confirmed winner', async () => {
  await registerForgeFunding(testConfig, sender, hash);
  await registerForgeFunding(testConfig, sender, replacement);
  jest
    .mocked(EthereumLaunchChain.prototype.receipt)
    .mockImplementation(async (value) =>
      value === replacement
        ? {
            status: 1,
            blockNumber: 100,
            blockHash: 'canonical',
            confirmations: 12
          }
        : null
    );
  await processForgeFunding(testConfig, { id, revision: 0 });
  expect(notifier.postForgeReport).toHaveBeenCalledWith(
    testConfig,
    expect.stringContaining(replacement),
    false,
    expect.any(Object)
  );
});
it('rejects another sender, wrong destination or chain without creating a record', async () => {
  await expect(
    registerForgeFunding(testConfig, testConfig.signer, hash)
  ).rejects.toThrow('does not match');
  transaction.to = sender;
  transaction.value = BigInt(1);
  await expect(registerForgeFunding(testConfig, sender, hash)).rejects.toThrow(
    'does not match'
  );
  transaction.to = testConfig.signer;
  transaction.chainId = BigInt(1);
  await expect(registerForgeFunding(testConfig, sender, hash)).rejects.toThrow(
    'does not match'
  );
});

afterEach(() => jest.restoreAllMocks());

it('tracks a redirected replacement without reporting a successful top-up', async () => {
  await registerForgeFunding(testConfig, sender, hash);
  transaction.to = sender;
  transaction.data = '0x1234';
  await registerForgeFunding(testConfig, sender, replacement);
  jest
    .mocked(EthereumLaunchChain.prototype.receipt)
    .mockImplementation(async (value) =>
      value === replacement
        ? {
            status: 1,
            blockNumber: 100,
            blockHash: 'canonical',
            confirmations: 12
          }
        : null
    );
  await processForgeFunding(testConfig, { id, revision: 0 });
  expect(notifier.postForgeReport).toHaveBeenCalledWith(
    testConfig,
    expect.stringContaining('replaced by a different transaction'),
    false,
    expect.any(Object)
  );
});
