import { ApiDropForgeControlRequestOperationEnum as ControlOperation } from '@/api/generated/models/ApiDropForgeControlRequest';
import { JsonRpcProvider } from 'ethers';
import * as rpc from '@/ethereum-rpc/ethereum-rpc-provider';
import { EthereumLaunchChain } from '@/drop-forge/drop-forge.chain';
import * as configuration from '@/drop-forge/drop-forge.config';
import * as reporting from '@/drop-forge/drop-forge.reporting-access';
import {
  dropForgeRepository,
  launchId
} from '@/drop-forge/drop-forge.repository';
import { dropForgePreparationRepository } from '@/drop-forge/drop-forge.preparation.repository';
import { controlLaunch, mapLaunch } from '@/drop-forge/drop-forge.service';
import {
  LaunchRevisionConflict,
  LaunchSafetyError
} from '@/drop-forge/drop-forge.types';
import {
  testConfig,
  testLaunchData,
  testSource
} from '@/drop-forge/drop-forge.test-fixtures';
import { clearDropForgeTestTables } from '@/drop-forge/drop-forge.db-test-fixtures';
import { sqlExecutor } from '@/sql-executor';

describe('Drop Forge operator controls', () => {
  beforeEach(clearDropForgeTestTables);
  const id = launchId(testConfig.chainId, testConfig.creator, 1);
  beforeEach(async () => {
    jest.spyOn(reporting, 'validateForgeReporting').mockResolvedValue('bot');
    jest
      .spyOn(rpc, 'getEthereumRpcProvider')
      .mockReturnValue({} as JsonRpcProvider);
    jest.spyOn(configuration, 'getDropForgeConfig').mockReturnValue(testConfig);
    jest.spyOn(dropForgeRepository, 'source').mockResolvedValue(testSource);
    jest.spyOn(dropForgeRepository, 'assertPrepared').mockResolvedValue();
    jest.spyOn(EthereumLaunchChain.prototype, 'now').mockResolvedValue(900);
    jest.spyOn(EthereumLaunchChain.prototype, 'verify').mockResolvedValue();
    await dropForgeRepository.putDraft(id, 0, testLaunchData(), {});
  });
  afterEach(() => jest.restoreAllMocks());
  it('arms with the latest revision and freezes further preparation', async () => {
    const draft = (await dropForgeRepository.find(id, {}))!;
    const armed = await controlLaunch(
      testConfig.creator,
      1,
      { revision: draft.revision, operation: ControlOperation.Arm },
      {}
    );
    expect(armed.state).toBe('ARMED');
    expect(EthereumLaunchChain.prototype.verify).toHaveBeenCalled();
    await expect(
      controlLaunch(
        testConfig.creator,
        1,
        { revision: draft.revision, operation: ControlOperation.Pause },
        {}
      )
    ).rejects.toBeInstanceOf(LaunchRevisionConflict);
    await expect(
      dropForgePreparationRepository.run(
        testConfig.creator,
        1,
        async () => undefined,
        {}
      )
    ).rejects.toThrow('frozen');
  });
  it('rejects pausing a draft so resume cannot bypass arming', async () => {
    const draft = (await dropForgeRepository.find(id, {}))!;
    await expect(
      controlLaunch(
        testConfig.creator,
        1,
        { revision: draft.revision, operation: ControlOperation.Pause },
        {}
      )
    ).rejects.toThrow('Control is not valid');
    await expect(
      controlLaunch(
        testConfig.creator,
        1,
        { revision: draft.revision, operation: ControlOperation.Resume },
        {}
      )
    ).rejects.toThrow('Control is not valid');
    expect((await dropForgeRepository.find(id, {}))!.state).toBe('DRAFT');
  });
  it('pauses and resumes an armed launch without changing its plan', async () => {
    const draft = (await dropForgeRepository.find(id, {}))!;
    const armed = await controlLaunch(
      testConfig.creator,
      1,
      { revision: draft.revision, operation: ControlOperation.Arm },
      {}
    );
    const paused = await controlLaunch(
      testConfig.creator,
      1,
      { revision: armed.revision, operation: ControlOperation.Pause },
      {}
    );
    expect(paused.state).toBe('PAUSED');
    const resumed = await controlLaunch(
      testConfig.creator,
      1,
      { revision: paused.revision, operation: ControlOperation.Resume },
      {}
    );
    expect(resumed.state).toBe('RUNNING');
    expect(resumed.data.distribution_hash).toBe(draft.data.distribution_hash);
    expect(resumed.data.actions).toEqual(draft.data.actions);
  });
  it('sees concurrent arming after a preparation job established its snapshot', async () => {
    const draft = (await dropForgeRepository.find(id, {}))!;
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      const ctx = { connection };
      expect((await dropForgeRepository.find(id, ctx))!.state).toBe('DRAFT');
      await controlLaunch(
        testConfig.creator,
        1,
        { revision: draft.revision, operation: ControlOperation.Arm },
        {}
      );
      const publish = jest.fn().mockResolvedValue(undefined);
      await expect(
        dropForgePreparationRepository.run(testConfig.creator, 1, publish, ctx)
      ).rejects.toThrow('frozen');
      expect(publish).not.toHaveBeenCalled();
    });
  });
  it('refuses arming when the reporting bot cannot post', async () => {
    jest
      .spyOn(reporting, 'validateForgeReporting')
      .mockRejectedValue(
        new LaunchSafetyError('Reporting bot cannot read or post to the wave')
      );
    const draft = (await dropForgeRepository.find(id, {}))!;
    await expect(
      controlLaunch(
        testConfig.creator,
        1,
        { revision: draft.revision, operation: ControlOperation.Arm },
        {}
      )
    ).rejects.toThrow('Reporting bot cannot');
    expect((await dropForgeRepository.find(id, {}))!.state).toBe('DRAFT');
  });
  it('rejects changed source data and leaves the draft intact', async () => {
    jest
      .spyOn(dropForgeRepository, 'source')
      .mockResolvedValue({ ...testSource, metadata: 'changed' });
    const draft = (await dropForgeRepository.find(id, {}))!;
    await expect(
      controlLaunch(
        testConfig.creator,
        1,
        { revision: draft.revision, operation: ControlOperation.Arm },
        {}
      )
    ).rejects.toThrow('Distribution or metadata changed');
    expect((await dropForgeRepository.find(id, {}))!.state).toBe('DRAFT');
  });
  it('keeps signed intent on cancellation, hides raw bytes, and cannot restart a terminal ledger', async () => {
    await dropForgeRepository.change(
      id,
      async (record) => {
        record.state = 'RUNNING';
        record.data.actions[0].state = 'SIGNED';
        record.data.actions[0].signed_tx = 'private-signed-bytes';
        record.data.actions[0].unsigned_tx = 'unsigned-bytes';
      },
      {}
    );
    const running = (await dropForgeRepository.find(id, {}))!;
    const cancelled = await controlLaunch(
      testConfig.creator,
      1,
      { revision: running.revision, operation: ControlOperation.Cancel },
      {}
    );
    expect(cancelled.data.actions[0].signed_tx).toBe('private-signed-bytes');
    expect(JSON.stringify(mapLaunch(cancelled))).not.toContain('signed-bytes');
    await expect(
      controlLaunch(
        testConfig.creator,
        1,
        { revision: cancelled.revision, operation: ControlOperation.Resume },
        {}
      )
    ).rejects.toThrow('cannot be restarted');
    await expect(
      dropForgeRepository.putDraft(id, cancelled.revision, testLaunchData(), {})
    ).rejects.toThrow('cannot be reset');
  });
});
