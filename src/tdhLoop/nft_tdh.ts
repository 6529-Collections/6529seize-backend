import { GRADIENT_CONTRACT, MEMES_CONTRACT } from '../constants';
import { NFT } from '../entities/INFT';
import { areEqualAddresses } from '../helpers';
import {
  fetchAllConsolidatedTdh,
  fetchAllNFTs,
  persistNFTs,
  persistNextGenTokenTDH
} from '../db';
import { ConsolidatedTDH } from '../entities/ITDH';
import { Logger } from '../logging';
import { NextGenToken, NextGenTokenTDH } from '../entities/INextGen';
import { fetchNextgenTokens } from '../nextgen/nextgen.db';

const logger = Logger.get('NFT_TDH');

export const findNftTDH = async () => {
  const tdhs: ConsolidatedTDH[] = await fetchAllConsolidatedTdh();

  logger.info(`[WALLETS ${tdhs.length}]`);

  const nfts: NFT[] = await fetchAllNFTs();
  const nftTDH: NFT[] = [];

  const nextgenNfts: NextGenToken[] = await fetchNextgenTokens();
  const nextgenTdh: NextGenTokenTDH[] = [];

  tdhs.forEach((tdh) => {
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
    tdh.nextgen?.map((nextgen: any) => {
      const token = nextgenNfts.find((n) => n.id == nextgen.id);
      if (token) {
        nextgenTdh.push({
          id: nextgen.id,
          normalised_id: token.normalised_id,
          consolidation_key: tdh.consolidation_key,
          collection_id: token.collection_id,
          block: tdh.block,
          tdh: nextgen.tdh,
          boosted_tdh: nextgen.tdh * tdh.boost,
          tdh__raw: nextgen.tdh__raw,
          tdh_rank: nextgen.rank
        });
      }
    });
  });

  nftTDH.sort((a, b) => {
    if (a.tdh > b.tdh) {
      return -1;
    }
    if (a.tdh > 0) {
      return 1;
    }
    return -1;
  });
  nftTDH.forEach((n, index) => (n.tdh_rank = index + 1));

  await persistNFTs(nftTDH);
  await persistNextGenTokenTDH(nextgenTdh);

  return nftTDH;
};
