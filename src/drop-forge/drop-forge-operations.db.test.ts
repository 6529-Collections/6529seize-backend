import { JsonRpcProvider } from 'ethers';
import * as rpc from '@/ethereum-rpc/ethereum-rpc-provider';
import {
  readyLaunch,
  requestMetadataUpdate,
  coordinateManual
} from '@/drop-forge/drop-forge.operations';
import { DROP_FORGE_EVIDENCE_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { storeEvidence } from '@/drop-forge/drop-forge.evidence';
import { dropForgeRepository } from '@/drop-forge/drop-forge.repository';
import * as config from '@/drop-forge/drop-forge.config';
import * as schedule from '@/drop-forge/drop-forge.schedule';
import * as workflow from '@/drop-forge/drop-forge.workflow';
import * as reporting from '@/drop-forge/drop-forge.reporting-access';
import * as wake from '@/drop-forge/drop-forge.wake';
import { EthereumLaunchChain } from '@/drop-forge/drop-forge.chain';
import {
  testConfig,
  testSource,
  testPlan
} from '@/drop-forge/drop-forge.test-fixtures';
import { clearDropForgeTestTables } from '@/drop-forge/drop-forge.db-test-fixtures';
const previous = process.env.DROP_FORGE_AUTOMATION_ENABLED;
beforeEach(async () => {
  await clearDropForgeTestTables();
  process.env.DROP_FORGE_AUTOMATION_ENABLED = 'true';
  jest.spyOn(config, 'getDropForgeConfig').mockReturnValue(testConfig);
  jest
    .spyOn(rpc, 'getEthereumRpcProvider')
    .mockReturnValue({} as JsonRpcProvider);
  jest.spyOn(EthereumLaunchChain.prototype, 'now').mockResolvedValue(1100);
  jest.spyOn(EthereumLaunchChain.prototype, 'nonce').mockResolvedValue(0);
  jest.spyOn(dropForgeRepository, 'source').mockResolvedValue(testSource);
  jest.spyOn(dropForgeRepository, 'assertPrepared').mockResolvedValue();
  jest
    .spyOn(schedule, 'standardLaunchPlan')
    .mockReturnValue({ ...testPlan, initialize_at: 1100 });
  jest.spyOn(workflow, 'assertProcessComplete').mockResolvedValue();
  jest.spyOn(reporting, 'validateForgeReporting').mockResolvedValue('bot');
  jest.spyOn(wake, 'wakeDropForge').mockResolvedValue();
});
afterEach(() => {
  jest.restoreAllMocks();
  if (previous === undefined) delete process.env.DROP_FORGE_AUTOMATION_ENABLED;
  else process.env.DROP_FORGE_AUTOMATION_ENABLED = previous;
});
it('accepts concurrent Ready clicks as one immediately due launch', async () => {
  const [a, b] = await Promise.all([readyLaunch(1, {}), readyLaunch(1, {})]);
  expect(a.id).toBe(b.id);
  expect(a.state).toBe('ARMED');
  expect(b.state).toBe('ARMED');
  expect(a.data.actions[0].due).toBe(1100);
  expect(a.data.managed).toBe(true);
});
it('queues one published metadata update without replaying initialized or airdrop actions', async () => {
  const ready = await readyLaunch(1, {});
  await dropForgeRepository.change(
    ready.id,
    async (record) => {
      record.data.actions[0].state = 'CONFIRMED';
    },
    {}
  );
  jest
    .spyOn(dropForgeRepository, 'source')
    .mockResolvedValue({ ...testSource, metadata: 'new-publication' });
  const updated = await requestMetadataUpdate(1, {});
  const repeated = await requestMetadataUpdate(1, {});
  expect(
    updated.data.actions.filter((action) => action.kind === 'METADATA')
  ).toHaveLength(1);
  expect(
    repeated.data.actions.filter((action) => action.kind === 'METADATA')
  ).toHaveLength(1);
  expect(updated.data.actions[0].state).toBe('CONFIRMED');
  await dropForgeRepository.change(
    ready.id,
    async (record) => {
      record.state = 'BLOCKED';
      record.error =
        'A newer Craft publication exists; request its metadata update';
    },
    {}
  );
  jest
    .spyOn(dropForgeRepository, 'source')
    .mockResolvedValue({ ...testSource, metadata: 'newest-publication' });
  const newest = await requestMetadataUpdate(1, {});
  expect(newest.state).toBe('RUNNING');
  expect(
    newest.data.actions.filter((it) => it.kind === 'METADATA')
  ).toHaveLength(1);
  expect(
    newest.data.actions.find((it) => it.kind === 'METADATA')?.target_metadata
  ).toBe('newest-publication');
  expect(newest.data.actions[0].state).toBe('CONFIRMED');
});
it('pauses for manual work and cancels only when no nonce was consumed', async () => {
  const ready = await readyLaunch(1, {});
  const lease = await coordinateManual(
    1,
    testConfig.signer,
    'BEGIN',
    undefined,
    undefined,
    undefined,
    {}
  );
  expect(lease).not.toBeNull();
  expect((await dropForgeRepository.find(ready.id, {}))?.state).toBe('PAUSED');
  await coordinateManual(
    1,
    testConfig.signer,
    'CANCEL',
    undefined,
    undefined,
    undefined,
    {}
  );
  expect((await dropForgeRepository.find(ready.id, {}))?.state).toBe('ARMED');
  const next = await coordinateManual(
    1,
    testConfig.signer,
    'BEGIN',
    undefined,
    undefined,
    undefined,
    {}
  );
  jest.spyOn(EthereumLaunchChain.prototype, 'nonce').mockResolvedValue(1);
  await expect(
    coordinateManual(
      1,
      testConfig.signer,
      'CANCEL',
      next ?? undefined,
      undefined,
      undefined,
      {}
    )
  ).rejects.toThrow('uncertain');
});

it('records direct ETH payment evidence under its manual lease without treating it as a contract call', async () => {
  const ready = await readyLaunch(1, {});
  const payment = jest
    .spyOn(EthereumLaunchChain.prototype, 'inspectPaymentSubmission')
    .mockResolvedValue();
  const contract = jest.spyOn(
    EthereumLaunchChain.prototype,
    'inspectTransaction'
  );
  const lease = await coordinateManual(
    1,
    testConfig.signer,
    'BEGIN',
    undefined,
    undefined,
    'PAY_ARTIST',
    {}
  );
  const hash = '0x' + 'ab'.repeat(32);
  await coordinateManual(
    1,
    testConfig.signer,
    'SUBMIT',
    lease!,
    hash,
    'PAY_ARTIST',
    {}
  );
  expect(payment).toHaveBeenCalledWith(hash, testConfig.signer);
  expect(contract).not.toHaveBeenCalled();
  const stored = (await dropForgeRepository.find(ready.id, {}))!;
  expect(stored.data.manual_transactions).toEqual([
    expect.objectContaining({ hash, action: 'PAY_ARTIST', state: 'PENDING' })
  ]);
  expect(stored.data.manual_lease).toBeUndefined();
});
it('refuses reusing payment evidence on another claim without relabeling the original proof', async () => {
  const hash = '0x' + 'cd'.repeat(32);
  await storeEvidence(testConfig, 1, hash, undefined, {});
  await expect(
    storeEvidence(testConfig, 2, hash, 'PAY_ARTIST', {})
  ).rejects.toThrow('already assigned');
  const row = await sqlExecutor.oneOrNull<{
    claim_id: number;
    action: string | null;
  }>(
    `SELECT claim_id, action FROM ${DROP_FORGE_EVIDENCE_TABLE} WHERE hash = :hash`,
    { hash }
  );
  expect(row).toMatchObject({ claim_id: 1, action: null });
});
