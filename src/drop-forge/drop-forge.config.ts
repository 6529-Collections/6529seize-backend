import { getAddress, isAddress, parseEther } from 'ethers';
import { UUID_REGEX } from '@/constants';
import { getDropForgePolicy } from '@/drop-forge/drop-forge.policy';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';

export interface DropForgeReportingConfig {
  waveId: string;
  botId: string;
  recipientIds: string[];
}
export interface DropForgeConfig extends DropForgeReportingConfig {
  maxArtistPayment?: bigint;
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
export const launchConfigured = () =>
  Boolean(process.env.DROP_FORGE_KMS_KEY_ID?.trim());

export const automationEnabled = () =>
  process.env.DROP_FORGE_AUTOMATION_ENABLED === 'true';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new LaunchSafetyError(`${name} is required`);
  return value;
}
function address(name: string): string {
  const value = required(name);
  if (!isAddress(value) || /^0x0{40}$/i.test(value))
    throw new LaunchSafetyError(`${name} must be a nonzero address`);
  return getAddress(value);
}
export function getDropForgeConfig(): DropForgeConfig {
  const policy = getDropForgePolicy();
  const reporting = getDropForgeReportingConfig();
  return {
    ...policy,
    ...reporting,
    ...(process.env.DROP_FORGE_MAX_ARTIST_PAYMENT_ETH?.trim()
      ? {
          maxArtistPayment: parseEther(
            process.env.DROP_FORGE_MAX_ARTIST_PAYMENT_ETH.trim()
          )
        }
      : {}),
    signer: address('DROP_FORGE_SIGNER_ADDRESS'),
    keyId: required('DROP_FORGE_KMS_KEY_ID')
  };
}

export function getDropForgeReportingConfig(): DropForgeReportingConfig {
  const waveId = required('DROP_FORGE_OPERATIONS_WAVE_ID');
  const botId = required('DROP_FORGE_BOT_PROFILE_ID');
  const recipientIds = Array.from(
    new Set(
      required('DROPS_6529_MENTION_PROFILE_IDS')
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
