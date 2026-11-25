import { MEMES_CONTRACT } from '@/constants';
import { getDropForgePolicy } from '@/drop-forge/drop-forge.policy';
import { isMemesContract } from '@/minting-claims/external-url';

export const MEMES_MINTING_CLAIM_ACTION_TYPES = [
  'ARTIST_AIRDROP',
  'TEAM_AIRDROP',
  'PHASE0_AIRDROP',
  'PHASE1_AIRDROP',
  'PHASE2_AIRDROP',
  'PUBLIC_PHASE_AIRDROP',
  'RESEARCH_AIRDROP',
  'PAY_ARTIST'
] as const;

export function mintingClaimActionsChainId(contract: string): number | null {
  if (isMemesContract(contract)) return 1;
  if (process.env.DROP_FORGE_STAGE !== 'staging') return null;
  const policy = getDropForgePolicy();
  return contract.toLowerCase() === policy.creator.toLowerCase()
    ? policy.chainId
    : null;
}

export function getSupportedMintingClaimActionTypes(
  contract: string
): readonly string[] {
  return mintingClaimActionsChainId(contract)
    ? MEMES_MINTING_CLAIM_ACTION_TYPES
    : [];
}

export function isSupportedMintingClaimActionType(
  contract: string,
  action: string
): boolean {
  return getSupportedMintingClaimActionTypes(contract).includes(action);
}

export function getMintingClaimActionsContractLabel(contract: string): string {
  if (isMemesContract(contract)) {
    return `MEMES (${MEMES_CONTRACT.toLowerCase()})`;
  }
  return contract.toLowerCase();
}
