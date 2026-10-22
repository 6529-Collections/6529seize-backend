import { Competition } from '@/competitions/competition.types';
import {
  normalizeWaveVotingCreditNfts,
  WaveVotingCreditNft
} from '@/waves/wave-voting-credit-nfts';

export function competitionCreditNfts(
  voting: Competition['voting']
): WaveVotingCreditNft[] {
  const nfts = voting.credit_nfts.map((nft) => ({
    contract: String(nft.contract ?? ''),
    tokenId: Number(nft.token_id ?? nft.tokenId)
  }));
  if (
    !nfts.length ||
    nfts.some(
      (nft) =>
        !/^0x[0-9a-f]{40}$/i.test(nft.contract) ||
        !Number.isSafeInteger(nft.tokenId) ||
        nft.tokenId < 0
    )
  ) {
    throw new Error('CARD_SET_TDH requires valid voting credit NFTs');
  }
  return normalizeWaveVotingCreditNfts(nfts);
}
