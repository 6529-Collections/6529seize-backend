import { MEMES_CONTRACT } from '@/constants';
import { isMemesContract } from '@/minting-claims/external-url';

export type MintingClaimActionType = string;

export const MEMES_MINTING_CLAIM_ACTION_TYPES = [
  'ARTIST_AIRDROP',
  'TEAM_AIRDROP',
  'PHASE0_AIRDROP',
  'PHASE1_AIRDROP',
  'PUBLIC_PHASE_AIRDROP',
  'RESEARCH_AIRDROP'
] as const;

export function getSupportedMintingClaimActionTypes(
  contract: string
): readonly string[] {
  if (isMemesContract(contract)) {
    return MEMES_MINTING_CLAIM_ACTION_TYPES;
  }
  return [];
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
