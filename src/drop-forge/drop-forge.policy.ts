import {
  MANIFOLD_LAZY_CLAIM_CONTRACT,
  MEMES_CONTRACT,
  MEMES_DEPLOYER
} from '@/constants';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';

// Contract bindings and gas limits change through code review, never secret overrides.
const policies = {
  prod: { chainId: 1, creator: MEMES_CONTRACT },
  staging: {
    chainId: 11155111,
    creator: '0xb84170c1073c7292ed108c3f0d1d2a1f304caa2c'
  }
} as const;
export function findDropForgePolicy() {
  const stage = process.env.DROP_FORGE_STAGE;
  if (stage !== 'prod' && stage !== 'staging') return null;
  return {
    ...policies[stage],
    proxy: MANIFOLD_LAZY_CLAIM_CONTRACT,
    receiver: MEMES_DEPLOYER,
    confirmations: 12,
    maxFee: BigInt('100000000000'),
    maxGas: BigInt('5000000'),
    maxCost: BigInt('100000000000000000')
  };
}
export function getDropForgePolicy() {
  const policy = findDropForgePolicy();
  if (!policy)
    throw new LaunchSafetyError(
      'Drop Forge deployment stage is missing or unsupported'
    );
  return policy;
}
