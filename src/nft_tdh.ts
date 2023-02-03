import { GRADIENT_CONTRACT, MEMES_CONTRACT } from './constants';
import { NftTDH } from './entities/INFT';
import { areEqualAddresses } from './helpers';
import { fetchAllTDH, persistNftTdh } from './db';
import { TDH } from './entities/ITDH';

export const findNftTDH = async () => {
  const tdhs: TDH[] = await fetchAllTDH();

  console.log(new Date(), '[NFT TDH]', `[WALLETS ${tdhs.length}]`);

  const nftTDH: NftTDH[] = [];

  tdhs.map((tdh) => {
    tdh.memes.map((meme: any) => {
      const existing = nftTDH.some(
        (n) => n.id == meme.id && areEqualAddresses(n.contract, MEMES_CONTRACT)
      );
      if (existing) {
        nftTDH.find(
          (n) =>
            n.id == meme.id && areEqualAddresses(n.contract, MEMES_CONTRACT)
        )!.tdh += meme.tdh;
        nftTDH.find(
          (n) =>
            n.id == meme.id && areEqualAddresses(n.contract, MEMES_CONTRACT)
        )!.tdh__raw += meme.tdh__raw;
      } else {
        const nTdh: NftTDH = {
          id: meme.id,
          tdh: meme.tdh,
          tdh__raw: meme.tdh__raw,
          contract: MEMES_CONTRACT,
          tdh_rank: 0 // assigned later
        };
        nftTDH.push(nTdh);
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
        )!.tdh += gradient.tdh;
        nftTDH.find(
          (n) =>
            n.id == gradient.id &&
            areEqualAddresses(n.contract, GRADIENT_CONTRACT)
        )!.tdh__raw += gradient.tdh__raw;
      } else {
        const nTdh: NftTDH = {
          id: gradient.id,
          tdh: gradient.tdh,
          tdh__raw: gradient.tdh__raw,
          contract: GRADIENT_CONTRACT,
          tdh_rank: 0 // assigned later
        };
        nftTDH.push(nTdh);
      }
    });
  });

  nftTDH
    .sort((a, b) => (a.tdh > b.tdh ? -1 : a.tdh > 0 ? 1 : -1))
    .map((n, index) => (n.tdh_rank = index + 1));

  await persistNftTdh(nftTDH);

  return nftTDH;
};
