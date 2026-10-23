import { JsonRpcProvider } from 'ethers';
import * as config from '@/drop-forge/drop-forge.config';
import * as rpc from '@/ethereum-rpc/ethereum-rpc-provider';
import * as wake from '@/drop-forge/drop-forge.wake';
import { EthereumLaunchChain } from '@/drop-forge/drop-forge.chain';
import { dropForgeRepository } from '@/drop-forge/drop-forge.repository';
import * as evidence from '@/drop-forge/drop-forge.evidence';
import {
  requestMetadataUpdate,
  coordinateManual
} from '@/drop-forge/drop-forge.operations';
import { hashLaunchDistribution } from '@/drop-forge/drop-forge.plan';
import {
  testConfig,
  testSource,
  testLaunchData
} from '@/drop-forge/drop-forge.test-fixtures';
import { LaunchRecord } from '@/drop-forge/drop-forge.types';
let record: LaunchRecord;
const previous = process.env.DROP_FORGE_AUTOMATION_ENABLED;
beforeEach(() => {
  process.env.DROP_FORGE_AUTOMATION_ENABLED = 'true';
  record = {
    id: 'launch',
    revision: 1,
    state: 'COMPLETED',
    error: null,
    data: testLaunchData(),
    updated_at: 1
  };
  record.data.managed = true;
  record.data.distribution_hash = hashLaunchDistribution(testSource);
  record.data.actions.forEach((action) => {
    action.state = 'CONFIRMED';
  });
  jest.spyOn(config, 'getDropForgeConfig').mockReturnValue(testConfig);
  jest
    .spyOn(rpc, 'getEthereumRpcProvider')
    .mockReturnValue({} as JsonRpcProvider);
  jest.spyOn(EthereumLaunchChain.prototype, 'now').mockResolvedValue(1100);
  jest
    .spyOn(dropForgeRepository, 'source')
    .mockResolvedValue({ ...testSource, metadata: 'publication-b' });
  jest
    .spyOn(dropForgeRepository, 'find')
    .mockImplementation(async () => record);
  jest
    .spyOn(dropForgeRepository, 'change')
    .mockImplementation(async (_id, fn) => {
      await fn(record, {});
      record.revision++;
      return record;
    });
  jest.spyOn(wake, 'wakeDropForge').mockResolvedValue();
});
afterEach(() => {
  jest.restoreAllMocks();
  if (previous === undefined) delete process.env.DROP_FORGE_AUTOMATION_ENABLED;
  else process.env.DROP_FORGE_AUTOMATION_ENABLED = previous;
});
it('reopens only metadata work and deduplicates requests without replaying completed airdrops', async () => {
  await requestMetadataUpdate(1, {});
  await requestMetadataUpdate(1, {});
  expect(record.state).toBe('RUNNING');
  expect(
    record.data.actions.filter((it) => it.kind === 'METADATA')
  ).toHaveLength(1);
  expect(
    record.data.actions
      .filter((it) => it.kind === 'AIRDROP')
      .every((it) => it.state === 'CONFIRMED')
  ).toBe(true);
});
it('supersedes stale unsigned metadata and recovers its precise publication block', async () => {
  await requestMetadataUpdate(1, {});
  record.state = 'BLOCKED';
  record.error =
    'A newer Craft publication exists; request its metadata update';
  jest
    .spyOn(dropForgeRepository, 'source')
    .mockResolvedValue({ ...testSource, metadata: 'publication-c' });
  await requestMetadataUpdate(1, {});
  expect(record.state).toBe('RUNNING');
  expect(record.error).toBeNull();
  const actions = record.data.actions.filter((it) => it.kind === 'METADATA');
  expect(actions).toHaveLength(1);
  expect(actions[0].target_metadata).toBe('publication-c');
});
it('does not replace a metadata transaction already signed or change allocation inputs', async () => {
  await requestMetadataUpdate(1, {});
  record.data.actions.find((it) => it.kind === 'METADATA')!.state = 'SIGNED';
  jest
    .spyOn(dropForgeRepository, 'source')
    .mockResolvedValue({ ...testSource, metadata: 'publication-c' });
  await expect(requestMetadataUpdate(1, {})).rejects.toThrow('in flight');
  jest.spyOn(dropForgeRepository, 'source').mockResolvedValue({
    ...testSource,
    edition: 101,
    metadata: 'publication-c'
  });
  await expect(requestMetadataUpdate(1, {})).rejects.toThrow(
    'Edition or distribution'
  );
});

it('routes a manual artist payment hash to native-transfer validation and keeps its exact category', async () => {
  const hash = '0x' + 'ab'.repeat(32);
  const payment = jest
    .spyOn(EthereumLaunchChain.prototype, 'inspectPaymentSubmission')
    .mockResolvedValue();
  const contract = jest.spyOn(
    EthereumLaunchChain.prototype,
    'inspectTransaction'
  );
  const proof = jest.spyOn(evidence, 'storeEvidence').mockResolvedValue();
  jest
    .spyOn(dropForgeRepository, 'wallet')
    .mockImplementation(async (_id, fn) =>
      fn({ launch_id: null, action_id: null }, {})
    );
  await coordinateManual(
    1,
    testConfig.signer,
    'SUBMIT',
    undefined,
    hash,
    'PAY_ARTIST',
    {}
  );
  expect(payment).toHaveBeenCalledWith(hash, testConfig.signer);
  expect(contract).not.toHaveBeenCalled();
  expect(proof).toHaveBeenCalledWith(testConfig, 1, hash, 'PAY_ARTIST', {});
  expect(record.data.manual_transactions).toEqual([
    expect.objectContaining({ hash, action: 'PAY_ARTIST', state: 'PENDING' })
  ]);
});
