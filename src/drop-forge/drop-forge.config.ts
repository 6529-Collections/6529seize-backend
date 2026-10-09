import { getAddress, isAddress, parseEther } from 'ethers';
import {
  MANIFOLD_LAZY_CLAIM_CONTRACT,
  MEMES_CONTRACT,
  MEMES_DEPLOYER,
  UUID_REGEX
} from '@/constants';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';

export interface DropForgeReportingConfig {
  waveId: string;
  botId: string;
  recipientIds: string[];
}
export interface DropForgeConfig extends DropForgeReportingConfig {
  chainId: number;
  creator: string;
  proxy: string;
  receiver: string;
  signer: string;
  keyId: string;
  confirmations: number;
  maxFee: bigint;
  maxGas: bigint;
  maxCost: bigint;
}
export const automationEnabled = () =>
  process.env.DROP_FORGE_AUTOMATION_ENABLED === 'true';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new LaunchSafetyError(`${name} is required`);
  return value;
}
function address(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback || required(name);
  if (!isAddress(value) || /^0x0{40}$/i.test(value))
    throw new LaunchSafetyError(`${name} must be a nonzero address`);
  return getAddress(value);
}
function integer(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new LaunchSafetyError(`${name} is out of range`);
  return value;
}
export function getDropForgeConfig(): DropForgeConfig {
  const chainId = Number(process.env.DROP_FORGE_CHAIN_ID ?? 11155111);
  if (chainId !== 1 && chainId !== 11155111)
    throw new LaunchSafetyError('Drop Forge supports mainnet and Sepolia only');
  const { waveId, botId, recipientIds } = getDropForgeReportingConfig();
  const maxFee = BigInt(required('DROP_FORGE_MAX_FEE_PER_GAS_WEI'));
  const maxGas = BigInt(required('DROP_FORGE_MAX_GAS_PER_TX'));
  const maxCost = parseEther(required('DROP_FORGE_MAX_TX_COST_ETH'));
  if (maxFee <= BigInt(0) || maxGas <= BigInt(0) || maxCost <= BigInt(0))
    throw new LaunchSafetyError('Gas budgets must be positive');
  return {
    chainId,
    waveId,
    botId,
    recipientIds,
    maxFee,
    maxGas,
    maxCost,
    creator: address(
      'DROP_FORGE_CREATOR_CONTRACT',
      chainId === 1 ? MEMES_CONTRACT : undefined
    ),
    proxy: address(
      'DROP_FORGE_LAZY_CLAIM_CONTRACT',
      MANIFOLD_LAZY_CLAIM_CONTRACT
    ),
    receiver: address(
      'DROP_FORGE_PAYMENT_RECEIVER',
      chainId === 1 ? MEMES_DEPLOYER : undefined
    ),
    signer: address('DROP_FORGE_SIGNER_ADDRESS'),
    keyId: required('DROP_FORGE_KMS_KEY_ID'),
    confirmations: integer('DROP_FORGE_CONFIRMATIONS', 12, 2, 64)
  };
}

export function getDropForgeReportingConfig(): DropForgeReportingConfig {
  const waveId = required('DROP_FORGE_OPERATIONS_WAVE_ID');
  const botId = required('DROP_FORGE_BOT_PROFILE_ID');
  const recipientIds = Array.from(
    new Set(
      required('DROP_FORGERS_6529_MENTION_PROFILE_IDS')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    )
  );
  if (
    ![waveId, botId, ...recipientIds].every((v) => UUID_REGEX.test(v)) ||
    !recipientIds.length
  )
    throw new LaunchSafetyError('Drop Forge reporting IDs must be UUIDs');
  return { waveId, botId, recipientIds };
}
