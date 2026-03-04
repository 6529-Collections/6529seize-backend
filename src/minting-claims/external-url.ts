import { MEMES_CONTRACT } from '@/constants';

export const ARWEAVE_METADATA_MEMES_EXTERNAL_URL_BASE =
  'https://6529.io/the-memes';

export function isMemesContract(contract: string): boolean {
  return contract.toLowerCase() === MEMES_CONTRACT.toLowerCase();
}

export function buildExternalUrl(
  contract: string,
  claimId: number
): string | null {
  if (!isMemesContract(contract)) {
    return null;
  }
  return `${ARWEAVE_METADATA_MEMES_EXTERNAL_URL_BASE}/${claimId}`;
}
