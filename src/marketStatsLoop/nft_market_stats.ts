import { areEqualAddresses, batchArray, delay, weiToEth } from '../helpers';
import {
  fetchNftsForContract,
  fetchAllMemeLabNFTs,
  persistLabNFTS,
  findVolume,
  persistNFTs
} from '../db';
import { MEMELAB_CONTRACT } from '../constants';
import { Logger } from '../logging';

const logger = Logger.get('NFT_MARKET_STATS');

async function getOpenseaResponseForPage(url: string, pageToken: string) {
  if (pageToken) {
    url += `&cursor=${pageToken}`;
  }
  return await fetch(url, {
    headers: {
      'x-api-key': process.env.OPENSEA_API_KEY!
    }
  });
}

export async function getOpenseaResponse(url: string): Promise<any[]> {
  let pageToken: any = '';
  const response = [];
  while (pageToken !== null) {
    try {
      const res = await getOpenseaResponseForPage(url, pageToken);
      const data: any = await res.json();
      response.push(...data.orders);
      pageToken = data.next;
    } catch (e) {
      logger.error(`[OPENSEA ERROR] ${e}`);
      pageToken = null;
    }
  }
  return response;
}

export const findNftMarketStats = async (contract: string) => {
  const nfts = await getNFTsForContract(contract);
  logger.info(
    `[CONTRACT ${contract}] [PROCESSING STATS FOR ${nfts.length} NFTS]`
  );

  const batchedTokens = batchArray(nfts, 30);

  for (let i = 0; i < batchedTokens.length; i++) {
    const batch = batchedTokens[i];
    const listingsUrl = buildOpenseaUrl(contract, 'listings', batch);
    const offersUrl = buildOpenseaUrl(contract, 'offers', batch);

    const listings = await getOpenseaResponse(listingsUrl);
    await delay(500);
    const offers = await getOpenseaResponse(offersUrl);

    const processedNfts = await processBatch(batch, listings, offers, contract);

    await persistNFTsForContract(contract, processedNfts);

    logBatchStatus(
      contract,
      processedNfts.length,
      batchedTokens.length - i - 1
    );

    await delay(500);
  }
};

const getNFTsForContract = async (contract: string): Promise<any[]> => {
  if (areEqualAddresses(contract, MEMELAB_CONTRACT)) {
    return fetchAllMemeLabNFTs('id desc');
  }
  return fetchNftsForContract(contract, 'id desc');
};

const buildOpenseaUrl = (
  contract: string,
  type: string,
  batch: any[]
): string => {
  let url = `https://api.opensea.io/api/v2/orders/ethereum/seaport/${type}?asset_contract_address=${contract}&limit=50`;

  for (const nft of batch) {
    url += `&token_ids=${nft.id}`;
  }

  return url;
};

const processBatch = async (
  batch: any[],
  listings: any[],
  offers: any[],
  contract: string
): Promise<any[]> => {
  const processedNfts = [];

  for (const nft of batch) {
    const nftListings = filterListingsForNft(listings, nft.id);
    const nftOffers = filterOffersForNft(offers, contract, nft.id);
    const lowestListing = getLowestListing(nftListings);
    const highestOffer = getHighestOffer(nftOffers);

    const volumes = await findVolume(nft.id, contract);
    updateNftVolumeStats(nft, volumes);
    updateNftMarketStats(nft, lowestListing, highestOffer);

    processedNfts.push(nft);
  }

  return processedNfts;
};

const filterListingsForNft = (listings: any[], nftId: string): any[] => {
  return listings.filter(
    (o) =>
      o.protocol_data?.parameters.offer[0].identifierOrCriteria ===
      nftId.toString()
  );
};

const filterOffersForNft = (
  offers: any[],
  contract: string,
  nftId: string
): any[] => {
  return offers.filter((o) =>
    o.protocol_data?.parameters.consideration.some(
      (f: any) =>
        areEqualAddresses(f.token, contract) &&
        f.identifierOrCriteria === nftId.toString()
    )
  );
};

const getLowestListing = (nftListings: any[]): any => {
  return (
    [...nftListings].sort((a, d) => a.current_price - d.current_price)?.[0] ??
    null
  );
};

const getHighestOffer = (nftOffers: any[]): any => {
  return (
    [...nftOffers].sort((a, d) => d.current_price - a.current_price)?.[0] ??
    null
  );
};

const updateNftVolumeStats = (nft: any, volumes: any): void => {
  nft.total_volume_last_24_hours = volumes?.total_volume_last_24_hours ?? 0;
  nft.total_volume_last_7_days = volumes?.total_volume_last_7_days ?? 0;
  nft.total_volume_last_1_month = volumes?.total_volume_last_1_month ?? 0;
  nft.total_volume = volumes?.total_volume ?? 0;
};

const updateNftMarketStats = (
  nft: any,
  lowestListing: any,
  highestOffer: any
): void => {
  let lowestListingPrice = weiToEth(lowestListing?.current_price ?? 0);
  lowestListingPrice = Math.round(lowestListingPrice * 10000) / 10000;
  nft.floor_price = lowestListingPrice;
  nft.market_cap = lowestListingPrice * nft.supply;

  let highestOfferPrice = weiToEth(highestOffer?.current_price ?? 0);
  highestOfferPrice = Math.round(highestOfferPrice * 10000) / 10000;
  nft.highest_offer = highestOfferPrice;
};

const persistNFTsForContract = async (
  contract: string,
  processedNfts: any[]
): Promise<void> => {
  if (areEqualAddresses(contract, MEMELAB_CONTRACT)) {
    await persistLabNFTS(processedNfts);
  } else {
    await persistNFTs(processedNfts);
  }
};

const logBatchStatus = (
  contract: string,
  processedNftsLength: number,
  remainingBatches: number
): void => {
  logger.info(
    `[CONTRACT ${contract}] [PROCESSED BATCH OF ${processedNftsLength}]${
      remainingBatches > 0
        ? ` [REMAINING BATCHES: ${remainingBatches}]`
        : '[LAST BATCH]'
    }`
  );
};
