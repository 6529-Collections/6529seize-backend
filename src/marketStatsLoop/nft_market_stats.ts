import {
  fetchAllMemeLabNFTs,
  fetchNftsForContract,
  findVolume,
  persistLabNFTS,
  persistNFTs
} from '../db';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '../constants';
import { Logger } from '../logging';
import { equalIgnoreCase } from '../strings';
import { BaseNFT } from '../entities/INFT';

const logger = Logger.get('NFT_MARKET_STATS');

type PriceResponse = {
  price: number;
  maker: string | null;
};

interface OpenSeaPriceResponse {
  currency: string;
  decimals: number;
  value: string;
}

interface OpenSeaUserResponse {
  protocol_data: {
    parameters: {
      offerer: string;
    };
  };
}

interface OpenSeaBestListingResponse extends OpenSeaUserResponse {
  price: {
    current: OpenSeaPriceResponse;
  };
}

interface OpenSeaBestOfferResponse extends OpenSeaUserResponse {
  price: OpenSeaPriceResponse;
}

const getBestListingForToken = async (
  collectionSlug: string,
  tokenId: number
): Promise<PriceResponse> => {
  const url = `https://api.opensea.io/api/v2/listings/collection/${collectionSlug}/nfts/${tokenId}/best`;
  const response = await fetch(url, {
    headers: {
      'x-api-key': process.env.OPENSEA_API_KEY!
    }
  });
  const data = (await response.json()) as OpenSeaBestListingResponse;

  return {
    price:
      data?.price?.current?.value && data.price.current.decimals
        ? Number(data.price.current.value) / 10 ** data.price.current.decimals
        : 0,
    maker: data?.protocol_data?.parameters?.offerer ?? null
  };
};

const getBestOfferForToken = async (
  collectionSlug: string,
  tokenId: number
): Promise<PriceResponse> => {
  const url = `https://api.opensea.io/api/v2/offers/collection/${collectionSlug}/nfts/${tokenId}/best`;
  const response = await fetch(url, {
    headers: {
      'x-api-key': process.env.OPENSEA_API_KEY!
    }
  });
  const data = (await response.json()) as OpenSeaBestOfferResponse;

  return {
    price:
      data?.price?.value && data.price.decimals
        ? Number(data.price.value) / 10 ** data.price.decimals
        : 0,
    maker: data?.protocol_data?.parameters?.offerer ?? null
  };
};

export const findNftMarketStats = async (contract: string) => {
  const nfts = await getNFTsForContract(contract);
  logger.info(
    `[CONTRACT ${contract}] [PROCESSING STATS FOR ${nfts.length} NFTS]`
  );

  let collectionSlug = '';
  switch (contract) {
    case MEMES_CONTRACT:
      collectionSlug = 'thememes6529';
      break;
    case MEMELAB_CONTRACT:
      collectionSlug = 'memelab6529';
      break;
    case GRADIENT_CONTRACT:
      collectionSlug = '6529-gradient';
      break;
    default:
      throw new Error(`Unknown contract: ${contract}`);
  }

  const BATCH_SIZE = 20;
  const totalBatches = Math.ceil(nfts.length / BATCH_SIZE);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const start = batchIndex * BATCH_SIZE;
    const end = start + BATCH_SIZE;
    const batch = nfts.slice(start, end);

    const processedBatch: BaseNFT[] = [];

    await Promise.all(
      batch.map(async (nft) => {
        const bestOffer = await getBestOfferForToken(collectionSlug, nft.id);
        const bestListing = await getBestListingForToken(
          collectionSlug,
          nft.id
        );

        logger.debug(
          `[NFT ${nft.id}] [BEST OFFER: ${bestOffer.price}] [BEST LISTING: ${bestListing.price}]`
        );

        const volumes = await findVolume(nft.id, contract);
        updateNftVolumeStats(nft, volumes);
        updateNftMarketStats(nft, bestListing, bestOffer);

        processedBatch.push(nft);
      })
    );

    await persistNFTsForContract(contract, processedBatch);
    logger.info(
      `[CONTRACT ${contract}] [PROCESSED BATCH ${batchIndex + 1}/${totalBatches}]`
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
