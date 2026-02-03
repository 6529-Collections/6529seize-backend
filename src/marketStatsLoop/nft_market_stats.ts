import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '@/constants';
import {
  fetchAllMemeLabNFTs,
  fetchNftsForContract,
  findVolume,
  persistLabNFTS,
  persistNFTs
} from '../db';
import { BaseNFT } from '../entities/INFT';
import { Logger } from '../logging';
import { equalIgnoreCase } from '../strings';
import {
  fetchBestListingsForCollection,
  fetchBestOffersForCollection,
  PriceResponse
} from './nft_market_stats_prices';

const logger = Logger.get('NFT_MARKET_STATS');

export const findNftMarketStats = async (contract: string) => {
  let collectionSlug = '';
  let itemType = 0;
  if (equalIgnoreCase(contract, MEMES_CONTRACT)) {
    collectionSlug = 'thememes6529';
    itemType = 3;
  } else if (equalIgnoreCase(contract, MEMELAB_CONTRACT)) {
    collectionSlug = 'memelab6529';
    itemType = 3;
  } else if (equalIgnoreCase(contract, GRADIENT_CONTRACT)) {
    collectionSlug = '6529-gradient';
    itemType = 2;
  } else {
    throw new Error(`Unknown contract: ${contract}`);
  }

  logger.info(`[COLLECTION ${collectionSlug}] FINDING BEST PRICES...`);

  const offersMap = await fetchBestOffersForCollection(
    collectionSlug,
    itemType
  );

  logger.info(`[COLLECTION ${collectionSlug}] FINDING BEST LISTINGS...`);
  const listingsMap = await fetchBestListingsForCollection(
    collectionSlug,
    itemType
  );

  const nfts = await getNFTsForContract(contract);
  const BATCH_SIZE = 50;
  const totalBatches = Math.ceil(nfts.length / BATCH_SIZE);

  logger.info(
    `[COLLECTION ${collectionSlug}] [PROCESSING STATS FOR ${nfts.length} NFTS IN ${totalBatches} BATCHES]`
  );

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const start = batchIndex * BATCH_SIZE;
    const end = start + BATCH_SIZE;
    const batch = nfts.slice(start, end);

    const processedBatch: BaseNFT[] = [];

    await Promise.all(
      batch.map(async (nft) => {
        const bestOffer = offersMap.get(nft.id.toString()) ?? {
          price: 0,
          maker: null
        };
        const bestListing = listingsMap.get(nft.id.toString()) ?? {
          price: 0,
          maker: null
        };

        const volumes = await findVolume(nft.id, contract);
        updateNftVolumeStats(nft, volumes);
        updateNftMarketStats(nft, bestListing, bestOffer);

        processedBatch.push(nft);
      })
    );

    await persistNFTsForContract(contract, processedBatch);
    logger.info(
      `[COLLECTION ${collectionSlug}] [PROCESSED BATCH ${batchIndex + 1}/${totalBatches}]`
    );
  }
};

const getNFTsForContract = async (contract: string): Promise<BaseNFT[]> => {
  if (equalIgnoreCase(contract, MEMELAB_CONTRACT)) {
    return fetchAllMemeLabNFTs('id desc');
  }
  return fetchNftsForContract(contract, 'id desc');
};

const updateNftVolumeStats = (nft: any, volumes: any): void => {
  nft.total_volume_last_24_hours = volumes?.total_volume_last_24_hours ?? 0;
  nft.total_volume_last_7_days = volumes?.total_volume_last_7_days ?? 0;
  nft.total_volume_last_1_month = volumes?.total_volume_last_1_month ?? 0;
  nft.total_volume = volumes?.total_volume ?? 0;
};

const updateNftMarketStats = (
  nft: any,
  lowestListing: PriceResponse,
  highestOffer: PriceResponse
): void => {
  nft.floor_price = lowestListing.price;
  nft.floor_price_from = lowestListing.maker;
  nft.market_cap = lowestListing.price * nft.supply;
  nft.highest_offer = highestOffer.price;
  nft.highest_offer_from = highestOffer.maker;
};

const persistNFTsForContract = async (
  contract: string,
  processedNfts: any[]
): Promise<void> => {
  if (equalIgnoreCase(contract, MEMELAB_CONTRACT)) {
    await persistLabNFTS(processedNfts);
  } else {
    await persistNFTs(processedNfts);
  }
};
