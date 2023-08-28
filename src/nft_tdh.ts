import { GRADIENT_CONTRACT, MEMES_CONTRACT } from './constants';
import { NFT } from './entities/INFT';
import { areEqualAddresses } from './helpers';
import { fetchAllNFTs, fetchAllConsolidatedTDH, persistNFTs } from './db';
import { TDH } from './entities/ITDH';

export const findNftTDH = async () => {
  const tdhs: TDH[] = await fetchAllConsolidatedTDH();

  console.log(new Date(), '[NFT TDH]', `[WALLETS ${tdhs.length}]`);

  const nfts: NFT[] = await fetchAllNFTs();
  const nftTDH: NFT[] = [];

  tdhs.map((tdh) => {
    tdh.memes.map((meme: any) => {
      const existing = nftTDH.some(
        (n) => n.id == meme.id && areEqualAddresses(n.contract, MEMES_CONTRACT)
      );
      if (existing) {
        nftTDH.find(
          (n) =>
            n.id == meme.id && areEqualAddresses(n.contract, MEMES_CONTRACT)
        )!.boosted_tdh += meme.tdh * tdh.boost;
        nftTDH.find(
          (n) =>
            n.id == meme.id && areEqualAddresses(n.contract, MEMES_CONTRACT)
        )!.tdh += meme.tdh;
        nftTDH.find(
          (n) =>
            n.id == meme.id && areEqualAddresses(n.contract, MEMES_CONTRACT)
        )!.tdh__raw += meme.tdh__raw;
      } else {
        const nft = nfts.find(
          (n) =>
            n.id == meme.id && areEqualAddresses(n.contract, MEMES_CONTRACT)
        );
        if (nft) {
          nft.boosted_tdh = meme.tdh * tdh.boost;
          nft.tdh = meme.tdh;
          nft.tdh__raw = meme.tdh__raw;
          nftTDH.push(nft);
        }
      }
    });
    tdh.gradients.map((gradient: any) => {
      const existing = nftTDH.some(
        (n) =>
          n.id == gradient.id &&
          areEqualAddresses(n.contract, GRADIENT_CONTRACT)
      );
      if (existing) {
        nftTDH.find(
          (n) =>
            n.id == gradient.id &&
            areEqualAddresses(n.contract, GRADIENT_CONTRACT)
        )!.boosted_tdh += gradient.tdh * tdh.boost;
        nftTDH.find(
          (n) =>
            n.id == gradient.id &&
            areEqualAddresses(n.contract, GRADIENT_CONTRACT)
        )!.tdh += gradient.tdh;
        nftTDH.find(
          (n) =>
            n.id == gradient.id &&
            areEqualAddresses(n.contract, GRADIENT_CONTRACT)
        )!.tdh__raw += gradient.tdh__raw;
      } else {
        const nft = nfts.find(
          (n) =>
            n.id == gradient.id &&
            areEqualAddresses(n.contract, GRADIENT_CONTRACT)
        );
        if (nft) {
          nft.boosted_tdh = gradient.tdh * tdh.boost;
          nft.tdh = gradient.tdh;
          nft.tdh__raw = gradient.tdh__raw;
          nftTDH.push(nft);
        }
      }
    });
  });

  nftTDH
    .sort((a, b) => (a.tdh > b.tdh ? -1 : a.tdh > 0 ? 1 : -1))
    .map((n, index) => (n.tdh_rank = index + 1));

  await persistNFTs(nftTDH);

  return nftTDH;
};
