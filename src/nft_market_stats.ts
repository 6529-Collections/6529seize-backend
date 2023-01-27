import { Utils } from 'alchemy-sdk';
import fetch from 'node-fetch';
import { MEMES_CONTRACT } from './constants';
import { NFT } from './entities/INFT';
import { areEqualAddresses, delay } from './helpers';

const config = require('./config');

async function getResult(url: string) {
  try {
    const response = await fetch(url, {
      headers: {
        'X-API-KEY': config.opensea.OPENSEA_API_KEY,
        accept: 'application/json'
      }
    });
    return response;
  } catch (err: any) {
    return null;
  }
}

const findFloorPrice = async (stat: any): Promise<number> => {
  let url;
  if (areEqualAddresses(stat.contract, MEMES_CONTRACT)) {
    url = `https://api.opensea.io/v2/orders/ethereum/seaport/listings?asset_contract_address=${stat.contract}&limit=1&token_ids=${stat.id}&order_by=eth_price&order_direction=asc`;
  } else {
    url = `https://api.opensea.io/v2/orders/ethereum/seaport/offers?asset_contract_address=${stat.contract}&limit=1&token_ids=${stat.id}&order_by=eth_price&order_direction=desc`;
  }

  const res = await getResult(url);

  if (res && res.status === 200) {
    const response = await res.json();
    let floorPrice = 0;
    if (response.orders && response.orders.length > 0) {
      floorPrice = response.orders[0].current_price;
    }
    return parseFloat(Utils.formatEther(floorPrice));
  } else {
    console.log(
      new Date(),
      '[NFT MARKET STATS]',
      `[THROTTLED!]`,
      `[CONTRACT ${stat.contract}]`,
      `[ID ${stat.id}]`,
      '[RETRYING IN 2500ms]'
    );
    await delay(2500);
    return findFloorPrice(stat);
  }
};

export const findNftMarketStats = async (contract: string, nfts: NFT[]) => {
  console.log(
    new Date(),
    '[NFT MARKET STATS]',
    `[CONTRACT ${contract}]`,
    `[PROCESSING STATS FOR ${nfts.length} NFTS]`
  );

  const processedStats: any[] = [];

  for (let i = 0; i < nfts.length; i++) {
    const nft = nfts[i];

    const floorPrice = await findFloorPrice(nft);
    nft.floor_price = floorPrice;
    nft.market_cap = floorPrice * nft.supply;
    processedStats.push(nft);
  }

  console.log(
    new Date(),
    '[NFT MARKET STATS]',
    `[PROCESSED ASSETS FOR ${processedStats.length} NFTS]`
  );
  return processedStats;
};
