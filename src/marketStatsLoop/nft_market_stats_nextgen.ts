import { EntityManager } from 'typeorm';
import { getDataSource } from '../db';
import { NextGenToken, NextGenTokenListing } from '../entities/INextGen';
import { batchArray, weiToEth } from '../helpers';
import { Logger } from '../logging';
import {
  fetchNextgenTokens,
  persitNextgenTokenListings
} from '../nextgen/nextgen.db';
import { NEXTGEN_ROYALTIES_ADDRESS } from '../nextgen/nextgen_constants';
import { getOpenseaResponse } from './nft_market_stats';
import { Time } from '../time';
import { equalIgnoreCase } from '../strings';

const logger = Logger.get('NEXTGEN_MARKET_STATS');

export const findNextgenMarketStats = async (contract: string) => {
  logger.info(`[CONTRACT ${contract}] [RUNNING]`);

  const blurListings = await getBlurListings(contract);
  const meListings = await getMagicEdenListings(contract);

  const dataSource = getDataSource();
  await dataSource.transaction(async (entityManager) => {
    const tokens: NextGenToken[] = await fetchNextgenTokens(entityManager);
    const sortedTokens = tokens.slice().sort((a, b) => a.id - b.id);
    const batchedTokens = batchArray(sortedTokens, 30);

    for (const batch of batchedTokens) {
      await processBatch(
        entityManager,
        batch,
        contract,
        blurListings,
        meListings
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });
};

async function processBatch(
  manager: EntityManager,
  tokens: NextGenToken[],
  contract: string,
  blurListings: any[],
  meListings: any[]
) {
  let url = `https://api.opensea.io/api/v2/orders/ethereum/seaport/listings?asset_contract_address=${contract}&limit=${tokens.length}`;
  for (const token of tokens) {
    url += `&token_ids=${token.id}`;
  }
  const orders: any[] = await getOpenseaResponse(url);
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
    const osOrder = orders?.find(
      (o) =>
        o.protocol_data.parameters.offer[0].identifierOrCriteria ===
        token.id.toString()
    );
    if (osOrder) {
      osPrice = weiToEth(osOrder.current_price);
      const listingRoyalty = osOrder.maker_fees?.find((f: any) =>
        equalIgnoreCase(f.account.address, NEXTGEN_ROYALTIES_ADDRESS)
      );
      osRoyalty = listingRoyalty ? listingRoyalty.basis_points / 100 : 0;
      osListingTime = osOrder.listing_time;
      osExpirationTime = osOrder.expiration_time;
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

      try {
        jsonResponse = await response.json();
        break;
      } catch (error: any) {
        const responseText = await response.text();
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
