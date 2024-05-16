import {
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  NEXTGEN_CONTRACT
} from '../constants';
import { fetchAllConsolidatedTdh, persistNFTs } from '../db';
import { NFT } from '../entities/INFT';
import { ConsolidatedTDH } from '../entities/ITDH';
import { Logger } from '../logging';

const logger = Logger.get('NFT_TDH');

export const processNftTdh = async (nfts: NFT[]) => {
  logger.info(`[NFTs ${nfts.length}]`);
  const allTdh = await fetchAllConsolidatedTdh();
  const nftTdh = nfts.map((n) => getTdhForNft(allTdh, n));
  await persistNFTs(nftTdh);
};

export const getTdhForNft = (allTdh: ConsolidatedTDH[], nft: NFT) => {
  let contractField: 'memes' | 'gradients' | 'nextgen' | undefined;
  switch (nft.contract) {
    case MEMES_CONTRACT.toLowerCase():
      contractField = 'memes';
      break;
    case GRADIENT_CONTRACT.toLowerCase():
      contractField = 'gradients';
      break;
    case NEXTGEN_CONTRACT.toLowerCase():
      contractField = 'nextgen';
      break;
  }

  if (!contractField) {
    return nft;
  }

  const entries = allTdh.filter((t) =>
    t[contractField].some((n) => n.id === nft.id)
  );
  let totalTdh = 0;
  entries.forEach((e) => {
    const nftTdh = e[contractField].find((n) => n.id === nft.id)?.tdh ?? 0;
    totalTdh += nftTdh * e.boost;
  });

  return {
    ...nft,
    tdh: totalTdh
  };
};
