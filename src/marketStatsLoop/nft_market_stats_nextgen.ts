import { EntityManager } from 'typeorm';
import { collections } from '../collections';
import { getDataSource } from '../db';
import { NextGenToken, NextGenTokenListing } from '../entities/INextGen';
import { ethTools } from '../eth-tools';
import { Logger } from '../logging';
import {
  fetchNextgenTokens,
  persitNextgenTokenListings
} from '../nextgen/nextgen.db';
import { NEXTGEN_ROYALTIES_ADDRESS } from '../nextgen/nextgen_constants';
import { equalIgnoreCase } from '../strings';
import { Time } from '../time';

const logger = Logger.get('NEXTGEN_MARKET_STATS');

const OPENSEA_API_BASE_URL = 'https://api.opensea.io/api/v2';
const OPENSEA_CHAIN = 'ethereum';
const OPENSEA_COLLECTION_LISTINGS_LIMIT = 200;

interface OpenSeaContractResponse {
  collection?: string;
}

interface OpenSeaPrice {
  decimals?: number;
  value?: string;
}

interface OpenSeaOfferItem {
  identifierOrCriteria?: string;
  identifier_or_criteria?: string;
  startAmount?: string;
}

interface OpenSeaConsiderationItem extends OpenSeaOfferItem {
  recipient?: string;
}

interface OpenSeaProtocolData {
  parameters?: {
    offer?: OpenSeaOfferItem[];
    consideration?: OpenSeaConsiderationItem[];
    startTime?: number | string;
    endTime?: number | string;
  };
}

interface OpenSeaFee {
  account?: {
    address?: string;
  };
  basis_points?: number;
}

export interface OpenSeaListing {
  current_price?: number | string;
  expiration_time?: number | string;
  listing_time?: number | string;
  maker_fees?: OpenSeaFee[];
  nft?: {
    identifier?: number | string;
  };
  criteria?: {
    data?: {
      token?: {
        tokenId?: number | string;
      };
    };
  };
  price?: {
    current?: OpenSeaPrice;
  };
  protocol_data?: OpenSeaProtocolData;
}

interface OpenSeaCollectionListingsResponse {
  listings?: OpenSeaListing[];
  next?: string | null;
}

export interface OpenSeaListingStats {
  expirationTime: number;
  listingTime: number;
  price: number;
  royalty: number;
}

function getOpenSeaHeaders(): Record<string, string> {
  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENSEA_API_KEY');
  }

  return {
    accept: 'application/json',
    'x-api-key': apiKey
  };
}

async function fetchOpenSeaJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      ...getOpenSeaHeaders()
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `[OPENSEA ERROR] ${response.status} ${response.statusText}: ${body}`
    );
  }

  return (await response.json()) as T;
}

export async function getOpenSeaCollectionSlug(
  contract: string
): Promise<string> {
  const url = `${OPENSEA_API_BASE_URL}/chain/${OPENSEA_CHAIN}/contract/${contract}`;
  const data = await fetchOpenSeaJson<OpenSeaContractResponse>(url);

  if (!data.collection) {
    throw new Error(
      `OpenSea contract response did not include collection slug`
    );
  }

  return data.collection;
}

export async function fetchOpenSeaCollectionListings(
  collectionSlug: string
): Promise<OpenSeaListing[]> {
  let next: string | null = null;
  const listings: OpenSeaListing[] = [];

  do {
    const url = new URL(
      `${OPENSEA_API_BASE_URL}/listings/collection/${encodeURIComponent(
        collectionSlug
      )}/all`
    );
    url.searchParams.set('limit', OPENSEA_COLLECTION_LISTINGS_LIMIT.toString());
    if (next) {
      url.searchParams.set('next', next);
    }

    logger.info(`Fetching ${url.toString()}`);
    const data = await fetchOpenSeaJson<OpenSeaCollectionListingsResponse>(
      url.toString()
    );
    logger.info(`Fetched ${url.toString()}`);

    if (!Array.isArray(data.listings)) {
      throw new Error(
        `OpenSea collection listings response is missing listings`
      );
    }

    listings.push(...data.listings);
    next = data.next ?? null;
  } while (next);

  return listings;
}

function toStringOrNull(value: number | string | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return value.toString();
}

function toNumberOrZero(value: number | string | undefined): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function getTokenIdFromOpenSeaListing(listing: OpenSeaListing): string | null {
  const offer = listing.protocol_data?.parameters?.offer ?? [];
  const tokenOffer = offer.find(
    (item) =>
      item.identifierOrCriteria !== undefined ||
      item.identifier_or_criteria !== undefined
  );

  return (
    toStringOrNull(tokenOffer?.identifierOrCriteria) ??
    toStringOrNull(tokenOffer?.identifier_or_criteria) ??
    toStringOrNull(listing.criteria?.data?.token?.tokenId) ??
    toStringOrNull(listing.nft?.identifier)
  );
}

function getOpenSeaStructuredPrice(price?: OpenSeaPrice): number {
  if (!price?.value) {
    return 0;
  }

  const value = Number(price.value);
  if (!Number.isFinite(value)) {
    return 0;
  }

  const decimals = price.decimals ?? 18;
  return value / Math.pow(10, decimals);
}

function getOpenSeaRawPriceValue(listing: OpenSeaListing): number {
  return toNumberOrZero(listing.price?.current?.value ?? listing.current_price);
}

function getOpenSeaEthPrice(listing: OpenSeaListing): number {
  const structuredPrice = getOpenSeaStructuredPrice(listing.price?.current);
  if (structuredPrice > 0) {
    return structuredPrice;
  }

  const currentPrice = toNumberOrZero(listing.current_price);
  return currentPrice > 0 ? ethTools.weiToEth(currentPrice) : 0;
}

function getOpenSeaLegacyRoyaltyPercent(listing: OpenSeaListing): number {
  const listingRoyalty = listing.maker_fees?.find((fee) =>
    equalIgnoreCase(fee.account?.address ?? '', NEXTGEN_ROYALTIES_ADDRESS)
  );
  const basisPoints = toNumberOrZero(listingRoyalty?.basis_points);
  return basisPoints > 0 ? basisPoints / 100 : 0;
}

function getOpenSeaConsiderationRoyaltyPercent(
  listing: OpenSeaListing
): number {
  const priceValue = getOpenSeaRawPriceValue(listing);
  if (priceValue <= 0) {
    return 0;
  }

  const royaltyValue =
    listing.protocol_data?.parameters?.consideration
      ?.filter((item) =>
        equalIgnoreCase(item.recipient ?? '', NEXTGEN_ROYALTIES_ADDRESS)
      )
      .reduce((total, item) => total + toNumberOrZero(item.startAmount), 0) ??
    0;

  return royaltyValue > 0 ? (royaltyValue / priceValue) * 100 : 0;
}

function getOpenSeaRoyaltyPercent(listing: OpenSeaListing): number {
  const legacyRoyaltyPercent = getOpenSeaLegacyRoyaltyPercent(listing);
  return legacyRoyaltyPercent > 0
    ? legacyRoyaltyPercent
    : getOpenSeaConsiderationRoyaltyPercent(listing);
}

export function getOpenSeaListingStats(
  listing: OpenSeaListing
): OpenSeaListingStats {
  return {
    expirationTime: toNumberOrZero(
      listing.expiration_time ?? listing.protocol_data?.parameters?.endTime
    ),
    listingTime: toNumberOrZero(
      listing.listing_time ?? listing.protocol_data?.parameters?.startTime
    ),
    price: getOpenSeaEthPrice(listing),
    royalty: getOpenSeaRoyaltyPercent(listing)
  };
}

export function indexBestOpenSeaListingsByTokenId(
  listings: OpenSeaListing[]
): Map<string, OpenSeaListing> {
  const listingsByTokenId = new Map<string, OpenSeaListing>();

  for (const listing of listings) {
    const tokenId = getTokenIdFromOpenSeaListing(listing);
    const price = getOpenSeaEthPrice(listing);
    if (!tokenId || price <= 0) {
      continue;
    }

    const existingListing = listingsByTokenId.get(tokenId);
    if (!existingListing || price < getOpenSeaEthPrice(existingListing)) {
      listingsByTokenId.set(tokenId, listing);
    }
  }

  return listingsByTokenId;
}

export const findNextgenMarketStats = async (contract: string) => {
  logger.info(`[CONTRACT ${contract}] [RUNNING]`);

  logger.info(`Getting OpenSea collection slug for contract: ${contract}`);
  const openSeaCollectionSlug = await getOpenSeaCollectionSlug(contract);
  logger.info(
    `Getting OpenSea listings for collection: ${openSeaCollectionSlug}`
  );
  const openSeaListings = await fetchOpenSeaCollectionListings(
    openSeaCollectionSlug
  );
  const openSeaListingsByTokenId =
    indexBestOpenSeaListingsByTokenId(openSeaListings);
  logger.info(
    `Got ${openSeaListings.length} OpenSea listings for collection: ${openSeaCollectionSlug}. Indexed ${openSeaListingsByTokenId.size} tokens.`
  );

  logger.info(`Getting Blur listings for contract: ${contract}`);
  const blurListings = await getBlurListings(contract);
  logger.info(`Got Blur listings for contract: ${contract}`);

  //Disabling Magic Eden listings for now
  // const meListings = await getMagicEdenListings(contract);
  const meListings: any[] = [];

  const dataSource = getDataSource();
  await dataSource.transaction(async (entityManager) => {
    logger.info(`Fetching NextGen tokens`);
    const tokens: NextGenToken[] = await fetchNextgenTokens(entityManager);
    logger.info(
      `Fetched ${tokens.length} NextGen tokens. Sorting and batching them...`
    );
    const sortedTokens = tokens.slice().sort((a, b) => a.id - b.id);
    const batchedTokens = collections.chunkArray(sortedTokens, 30);
    logger.info(
      `Starting to process ${batchedTokens.length} NextGen token batches.`
    );
    let i = 0;
    for (const batch of batchedTokens) {
      i++;
      logger.info(`Processing batch ${i}/${batchedTokens.length}`);
      await processBatch(
        entityManager,
        batch,
        contract,
        openSeaListingsByTokenId,
        blurListings,
        meListings
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      logger.info(`Batch ${i}/${batchedTokens.length} processed`);
    }
    logger.info(`All NextGen token batches processed.`);
  });
};

async function processBatch(
  manager: EntityManager,
  tokens: NextGenToken[],
  contract: string,
  openSeaListingsByTokenId: Map<string, OpenSeaListing>,
  blurListings: any[],
  meListings: any[]
) {
  const listings: NextGenTokenListing[] = [];

  for (const token of tokens) {
    let osPrice = 0;
    let osRoyalty = 0;
    let osListingTime = 0;
    let osExpirationTime = 0;
    let blurPrice = 0;
    let blurListingTime = 0;
    let mePrice = 0;
    let meListingTime = 0;
    let meExpirationTime = 0;
    let meRoyalty = 0;
    const osOrder = openSeaListingsByTokenId.get(token.id.toString());
    if (osOrder) {
      const osStats = getOpenSeaListingStats(osOrder);
      osPrice = osStats.price;
      osRoyalty = osStats.royalty;
      osListingTime = osStats.listingTime;
      osExpirationTime = osStats.expirationTime;
    }

    const blurListing = blurListings.find(
      (l) => l.tokenId === token.id.toString()
    );
    if (blurListing?.price) {
      blurPrice = blurListing.price?.amount;
      blurListingTime = new Date(blurListing.price?.listedAt).getTime() / 1000;
    }

    const meListing = meListings.find(
      (l) => l.criteria.data.token.tokenId === token.id.toString()
    );
    if (meListing?.price?.amount?.decimal) {
      mePrice = meListing?.price?.amount?.decimal;
      meListingTime = meListing?.validFrom;
      meExpirationTime = meListing?.validUntil;
      meRoyalty =
        (meListing.feeBreakdown.find((f: any) => f.kind === 'royalty')?.bps ??
          0) / 100;
    }

    const listing: NextGenTokenListing = {
      id: token.id,
      price: getMinPositivePrice([osPrice, blurPrice, mePrice]),
      opensea_price: osPrice,
      opensea_royalty: osRoyalty,
      opensea_listing_time: osListingTime,
      opensea_expiration_time: osExpirationTime,
      blur_price: blurPrice,
      blur_listing_time: blurListingTime,
      me_price: mePrice,
      me_listing_time: meListingTime,
      me_expiration_time: meExpirationTime,
      me_royalty: meRoyalty
    };
    listings.push(listing);
  }

  await persitNextgenTokenListings(manager, listings);
  logger.info(
    `[CONTRACT ${contract}] [TOKENS ${tokens[0].id} - ${
      tokens[tokens.length - 1].id
    }] [PROCESSED]`
  );
}

async function getBlurListings(contract: string): Promise<any[]> {
  const url = `https://blur.p.rapidapi.com/v1/collections/${contract}/tokens?filters=%7B%22marketplace%22%3A%22BLUR%22%7D`;
  const response = await fetch(url, {
    headers: {
      'X-RapidAPI-Key': process.env.RAPID_API_KEY!
    }
  });
  const jsonResponse: any = await response.json();
  return jsonResponse?.tokens ?? [];
}

async function getMagicEdenListings(contract: string): Promise<any[]> {
  let orders: any[] = [];
  let continuation: string | null = null;

  do {
    let jsonResponse: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const url = `https://api-mainnet.magiceden.dev/v3/rtp/ethereum/orders/asks/v5?contracts=${contract}&excludeEOA=true${
        continuation ? `&continuation=${continuation}` : ''
      }`;
      const response = await fetch(url);
      const responseText = await response.text();

      try {
        jsonResponse = JSON.parse(responseText);
        break;
      } catch (error: any) {
        if (attempt === 3) {
          const message = `Error getting JSON response from Magic Eden: ${JSON.stringify(
            error
          )}, response: ${responseText}`;
          throw new Error(message);
        } else {
          const delay = Time.seconds(10 * attempt);
          logger.error(
            `Attempt ${attempt} to fetch ${url} failed: ${responseText}. Waiting for ${delay} and trying again...`
          );
          await delay.sleep();
        }
      }
    }

    orders = orders.concat(jsonResponse?.orders ?? []);

    continuation = jsonResponse?.continuation ?? null;
  } while (continuation);

  return orders.filter((o) => o.source.name === 'Magic Eden');
}

function getMinPositivePrice(prices: number[]): number {
  const positivePrices = prices.filter((price) => price > 0);

  if (positivePrices.length === 0) {
    return 0;
  }

  const minPositivePrice = Math.min(...positivePrices);
  return minPositivePrice;
}
