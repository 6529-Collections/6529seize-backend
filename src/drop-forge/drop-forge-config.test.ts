import { getDropForgeConfig } from '@/drop-forge/drop-forge.config';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';
const names = [
  'DROP_FORGE_CHAIN_ID',
  'DROP_FORGE_CONFIRMATIONS',
  'DROP_FORGE_CREATOR_CONTRACT',
  'DROP_FORGE_PAYMENT_RECEIVER',
  'DROP_FORGE_SIGNER_ADDRESS',
  'DROP_FORGE_KMS_KEY_ID',
  'DROP_FORGE_OPERATIONS_WAVE_ID',
  'DROP_FORGE_BOT_PROFILE_ID',
  'DROP_FORGERS_6529_MENTION_PROFILE_IDS',
  'DROP_FORGE_MAX_FEE_PER_GAS_WEI',
  'DROP_FORGE_MAX_GAS_PER_TX',
  'DROP_FORGE_MAX_TX_COST_ETH'
];
const previous = Object.fromEntries(
  names.map((name) => [name, process.env[name]])
);
beforeEach(() => {
  process.env.DROP_FORGE_CREATOR_CONTRACT = testConfig.creator;
  process.env.DROP_FORGE_PAYMENT_RECEIVER = testConfig.receiver;
  process.env.DROP_FORGE_SIGNER_ADDRESS = testConfig.signer;
  process.env.DROP_FORGE_KMS_KEY_ID = 'test-key';
  process.env.DROP_FORGE_OPERATIONS_WAVE_ID =
    '11111111-1111-4111-8111-111111111111';
  process.env.DROP_FORGE_BOT_PROFILE_ID =
    '22222222-2222-4222-8222-222222222222';
  process.env.DROP_FORGERS_6529_MENTION_PROFILE_IDS =
    '33333333-3333-4333-8333-333333333333';
  process.env.DROP_FORGE_MAX_FEE_PER_GAS_WEI = '100000000000';
  process.env.DROP_FORGE_MAX_GAS_PER_TX = '1000000';
  process.env.DROP_FORGE_MAX_TX_COST_ETH = '0.1';
});
afterEach(() => {
  for (const name of names) {
    const value = previous[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
it.each(['', '   '])(
  'uses the documented chain and confirmation defaults for blank optional settings',
  (value) => {
    process.env.DROP_FORGE_CHAIN_ID = value;
    process.env.DROP_FORGE_CONFIRMATIONS = value;
    expect(getDropForgeConfig()).toMatchObject({
      chainId: 11155111,
      confirmations: 12
    });
  }
);
it('continues to reject explicit unsupported chains and invalid confirmation counts', () => {
  process.env.DROP_FORGE_CHAIN_ID = '42';
  expect(() => getDropForgeConfig()).toThrow('mainnet and Sepolia');
  process.env.DROP_FORGE_CHAIN_ID = '11155111';
  process.env.DROP_FORGE_CONFIRMATIONS = '1';
  expect(() => getDropForgeConfig()).toThrow('out of range');
});
