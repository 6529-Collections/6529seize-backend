import { recoverDropForgeLaunch } from '@/api/drop-forge/drop-forge-recovery.handler';
import * as config from '@/drop-forge/drop-forge.config';
import * as access from '@/drop-forge/drop-forge.service';
import * as auth from '@/api/auth/auth';
import { DropForgeRecovery } from '@/drop-forge/drop-forge.recovery';
import * as wake from '@/drop-forge/drop-forge.wake';
import {
  testConfig,
  testLaunchData
} from '@/drop-forge/drop-forge.test-fixtures';
import { ForbiddenException } from '@/exceptions';
import { RecoverDropForgeLaunchRequest } from '@/api/generated/routes/operations';
import { LaunchRecord } from '@/drop-forge/drop-forge.types';
jest.mock('@/ethereum-rpc/ethereum-rpc-provider', () => ({
  getEthereumRpcProvider: jest.fn(() => ({}))
}));
const record: LaunchRecord = {
  id: 'launch',
  revision: 1,
  state: 'BLOCKED',
  error: null,
  data: testLaunchData(),
  updated_at: 0
};
const request = (operation = 'CANCEL') =>
  ({
    params: { contract: testConfig.creator, claim_id: 1 },
    body: {
      revision: 1,
      request_id: '11111111-1111-4111-8111-111111111111',
      action_id: 'initialize',
      expected_hash: '0x' + 'a'.repeat(64),
      operation
    }
  }) as unknown as RecoverDropForgeLaunchRequest;
beforeEach(() => {
  jest.spyOn(config, 'getDropForgeConfig').mockReturnValue(testConfig);
  jest.spyOn(config, 'launchConfigured').mockReturnValue(true);
  jest.spyOn(config, 'automationEnabled').mockReturnValue(false);
  jest
    .spyOn(auth, 'getAuthenticatedWalletOrNull')
    .mockReturnValue(testConfig.signer);
  jest.spyOn(access, 'assertLaunchAccess').mockResolvedValue();
  jest.spyOn(DropForgeRecovery.prototype, 'request').mockResolvedValue(record);
  jest.spyOn(wake, 'wakeDropForge').mockResolvedValue();
});
afterEach(() => jest.restoreAllMocks());
it('requires administrator access before queuing or waking recovery', async () => {
  jest
    .mocked(access.assertLaunchAccess)
    .mockRejectedValue(new ForbiddenException('denied'));
  await expect(recoverDropForgeLaunch(request())).rejects.toThrow('denied');
  expect(DropForgeRecovery.prototype.request).not.toHaveBeenCalled();
  expect(wake.wakeDropForge).not.toHaveBeenCalled();
});
it('permits cancellation with recovery enabled while normal scheduled execution is disabled', async () => {
  expect((await recoverDropForgeLaunch(request())).id).toBe('launch');
  expect(access.assertLaunchAccess).toHaveBeenCalledWith(
    testConfig.signer,
    testConfig.creator
  );
  expect(wake.wakeDropForge).not.toHaveBeenCalled();
});
it.each(['RETRY', 'DELIVER_REMAINING'])(
  'does not permit %s while scheduled signing is disabled',
  async (operation) => {
    await expect(recoverDropForgeLaunch(request(operation))).rejects.toThrow(
      'Enable scheduled execution'
    );
    expect(DropForgeRecovery.prototype.request).not.toHaveBeenCalled();
  }
);
it('rejects unconfigured recovery and missing existing-transaction evidence', async () => {
  jest.mocked(config.launchConfigured).mockReturnValue(false);
  await expect(recoverDropForgeLaunch(request())).rejects.toThrow(
    'not configured'
  );
  jest.mocked(config.launchConfigured).mockReturnValue(true);
  await expect(
    recoverDropForgeLaunch(request('RECORD_WINNER'))
  ).rejects.toThrow();
  expect(DropForgeRecovery.prototype.request).not.toHaveBeenCalled();
});
