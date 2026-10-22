import {
  createDropForgeDistributionJob,
  mapJob
} from '@/api/drop-forge/drop-forge.handlers';
import { CreateDropForgeDistributionJobRequest } from '@/api/generated/routes/operations';
import * as access from '@/api/subscriptions/api.subscriptions.allowlist';
import * as workflow from '@/drop-forge/drop-forge.workflow';
import * as wake from '@/drop-forge/drop-forge.wake';
import { DropForgeJobEntity } from '@/entities/IDropForgeLaunch';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';

const request = () =>
  ({
    headers: { authorization: 'Bearer operator-token' },
    params: { contract: testConfig.creator, claim_id: 1 },
    body: {
      request_id: '11111111-1111-4111-8111-111111111111',
      kind: 'PROCESS_ALL',
      plan_id: 'plan',
      phase_ids: ['a', 'b', 'c']
    }
  }) as unknown as CreateDropForgeDistributionJobRequest;
const previous = process.env.DROP_FORGE_PREPARATION_ENABLED;
beforeEach(() => {
  process.env.DROP_FORGE_PREPARATION_ENABLED = 'true';
  jest.spyOn(access, 'authenticateSubscriptionsAdmin').mockReturnValue(true);
  jest.spyOn(workflow, 'createProcess').mockImplementation(async (job) => ({
    ...job,
    status: 'PENDING',
    encrypted_auth: 'ciphertext'
  }));
  jest.spyOn(wake, 'wakeDropForge').mockResolvedValue();
});
afterEach(() => {
  jest.restoreAllMocks();
  if (previous === undefined) delete process.env.DROP_FORGE_PREPARATION_ENABLED;
  else process.env.DROP_FORGE_PREPARATION_ENABLED = previous;
});
it('checks admin access before handing any operator credential to the durable workflow', async () => {
  jest.mocked(access.authenticateSubscriptionsAdmin).mockReturnValue(false);
  await expect(createDropForgeDistributionJob(request())).rejects.toThrow(
    'administrator access'
  );
  expect(workflow.createProcess).not.toHaveBeenCalled();
  expect(wake.wakeDropForge).not.toHaveBeenCalled();
});
it('hands the request header to the workflow and never returns credentials in the job API', async () => {
  const result = await createDropForgeDistributionJob(request());
  expect(workflow.createProcess).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'PROCESS_ALL' }),
    expect.anything(),
    'Bearer operator-token'
  );
  expect(JSON.stringify(result)).not.toMatch(
    /operator-token|encrypted_auth|ciphertext/
  );
  // Persistence owns the atomic queue handoff, not the HTTP handler.
  expect(wake.wakeDropForge).not.toHaveBeenCalled();
});
it('maps a waiting job without exposing its stored credential', () => {
  expect(
    mapJob(
      Object.assign(new DropForgeJobEntity(), {
        ...request().body,
        status: 'AWAITING_AUTH',
        encrypted_auth: 'ciphertext'
      })
    )
  ).not.toHaveProperty('encrypted_auth');
});
