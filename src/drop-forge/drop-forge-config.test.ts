import {
  getDropForgeConfig,
  automationEnabled
} from '@/drop-forge/drop-forge.config';
import { getDropForgePolicy } from '@/drop-forge/drop-forge.policy';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';
const previous = { ...process.env };
beforeEach(() => {
  process.env.DROP_FORGE_STAGE = 'staging';
  process.env.DROP_FORGE_SIGNER_ADDRESS = testConfig.signer;
  process.env.DROP_FORGE_KMS_KEY_ID = 'test-key';
  process.env.DROP_FORGE_OPERATIONS_WAVE_ID =
    '11111111-1111-4111-8111-111111111111';
  process.env.DROP_FORGE_BOT_PROFILE_ID =
    '22222222-2222-4222-8222-222222222222';
  process.env.DROPS_6529_MENTION_PROFILE_IDS =
    '33333333-3333-4333-8333-333333333333';
});
afterEach(() => {
  process.env = { ...previous };
});
it.each([
  ['staging', 11155111],
  ['prod', 1]
])('pins the %s environment to chain %s', (stage, chainId) => {
  process.env.DROP_FORGE_STAGE = stage as string;
  expect(getDropForgeConfig()).toMatchObject({ chainId, confirmations: 12 });
});
it('rejects an unknown or absent stage instead of choosing a network', () => {
  delete process.env.DROP_FORGE_STAGE;
  expect(getDropForgePolicy).toThrow('deployment stage');
  process.env.DROP_FORGE_STAGE = 'production';
  expect(getDropForgePolicy).toThrow('deployment stage');
});
it('cannot override contract, receiver or gas policy with retired secrets', () => {
  const expected = getDropForgeConfig();
  process.env.DROP_FORGE_CHAIN_ID = '1';
  process.env.DROP_FORGE_CREATOR_CONTRACT = testConfig.signer;
  process.env.DROP_FORGE_PAYMENT_RECEIVER = testConfig.signer;
  process.env.DROP_FORGE_MAX_TX_COST_ETH = '999';
  expect(getDropForgeConfig()).toEqual(expected);
});
it('keeps the explicit artist payment budget separate from gas policy', () => {
  delete process.env.DROP_FORGE_MAX_ARTIST_PAYMENT_ETH;
  expect(getDropForgeConfig().maxArtistPayment).toBeUndefined();
  process.env.DROP_FORGE_MAX_ARTIST_PAYMENT_ETH = '0.25';
  expect(getDropForgeConfig().maxArtistPayment).toBe(
    BigInt('250000000000000000')
  );
});
it('keeps the environment execution switch off by default', () => {
  delete process.env.DROP_FORGE_AUTOMATION_ENABLED;
  expect(automationEnabled()).toBe(false);
});
