import { collections } from '@/collections';

export type WaveVotingCreditNft = {
  contract: string;
  tokenId: number;
};

export function waveVotingCreditNftKey(
  contract: string,
  tokenId: number
): string {
  return `${contract.toLowerCase()}:${tokenId}`;
}

export function normalizeWaveVotingCreditNfts(
  creditNfts: readonly WaveVotingCreditNft[]
): WaveVotingCreditNft[] {
  return collections
    .distinctBy(
      creditNfts.map(({ contract, tokenId }) => ({
        contract: contract.toLowerCase(),
        tokenId
      })),
      ({ contract, tokenId }) => waveVotingCreditNftKey(contract, tokenId)
    )
    .sort(
      (left, right) =>
        left.contract.localeCompare(right.contract) ||
        left.tokenId - right.tokenId
    );
}

export function groupWaveVotingCreditNftsByContract(
  creditNfts: readonly WaveVotingCreditNft[]
): Array<{ contract: string; tokenIds: number[] }> {
  const grouped = normalizeWaveVotingCreditNfts(creditNfts).reduce(
    (acc, creditNft) => {
      const tokenIds = acc.get(creditNft.contract) ?? [];
      tokenIds.push(creditNft.tokenId);
      acc.set(creditNft.contract, tokenIds);
      return acc;
    },
    new Map<string, number[]>()
  );
  return Array.from(grouped.entries()).map(([contract, tokenIds]) => ({
    contract,
    tokenIds
  }));
}

export function sumWaveVotingCreditNftValues(
  creditNfts: readonly WaveVotingCreditNft[],
  creditByKey: Record<string, number>
): number {
  return normalizeWaveVotingCreditNfts(creditNfts).reduce(
    (acc, creditNft) =>
      acc +
      (creditByKey[
        waveVotingCreditNftKey(creditNft.contract, creditNft.tokenId)
      ] ?? 0),
    0
  );
}
