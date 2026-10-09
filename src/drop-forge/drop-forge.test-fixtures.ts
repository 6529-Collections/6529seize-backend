import { Wallet } from 'ethers';
import { DropForgeConfig } from '@/drop-forge/drop-forge.config';
import { LaunchSource, buildLaunchPlan } from '@/drop-forge/drop-forge.plan';
import { LaunchPlanInput } from '@/drop-forge/drop-forge.plan';

// Public, disposable test key. Never used by the runtime signer.
export const testWallet = new Wallet('0x' + '11'.repeat(32));
export const testConfig: DropForgeConfig = {
  chainId: 11155111,
  creator: '0x' + '22'.repeat(20),
  proxy: '0x' + '33'.repeat(20),
  receiver: '0x' + '44'.repeat(20),
  signer: testWallet.address,
  keyId: 'test-key',
  waveId: 'test-wave',
  botId: 'test-bot',
  recipientIds: ['test-admin'],
  confirmations: 12,
  maxFee: BigInt(100000000000),
  maxGas: BigInt(10000000),
  maxCost: BigInt(1000000000000000000)
};
export const testSource: LaunchSource = {
  metadata: 'arweave-metadata',
  edition: 100,
  rows: [
    {
      phase: 'Phase 0',
      wallet: '0x' + '55'.repeat(20),
      count: 2,
      count_airdrop: 1,
      count_allowlist: 1
    }
  ]
};
export const testPlan: LaunchPlanInput = {
  initialize_at: 1000,
  include_artist_airdrops: false,
  include_team_airdrops: false,
  phases: [
    {
      name: 'Phase 0',
      start: 4000,
      end: 5000,
      price_wei: '100',
      is_public: false
    },
    {
      name: 'Public',
      start: 6000,
      end: 7000,
      price_wei: '100',
      is_public: true
    }
  ]
};
export const testLaunchData = () =>
  buildLaunchPlan(testConfig, 1, testPlan, testSource, 0);
