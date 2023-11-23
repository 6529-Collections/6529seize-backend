import { Utils } from 'alchemy-sdk';
import { LabNFT, NFT } from './entities/INFT';
import { areEqualAddresses, delay } from './helpers';
import {
  fetchNftsForContract,
  fetchAllMemeLabNFTs,
  persistLabNFTS,
  findVolumeNFTs,
  findVolumeLab,
  persistNFTs
} from './db';
import { MEMELAB_CONTRACT } from './constants';
import { RequestInfo, RequestInit } from 'node-fetch';
import { Logger } from './logging';

const logger = Logger.get('NFT_MARKET_STATS');

const fetch = (url: RequestInfo, init?: RequestInit) =>
  import('node-fetch').then(({ default: fetch }) => fetch(url, init));

async function getResult(url: string) {
  try {
    const response = await fetch(url, {
      headers: {
        'X-API-KEY': process.env.OPENSEA_API_KEY!,
        accept: 'application/json',
        Origin: 'https://seize.io'
      }
    });
    if (!response.ok) {
      throw new Error(
        `Request failed with status ${
          response.status
        }. Respone ${JSON.stringify(response)}`
      );
    }
    return response;
  } catch (err: any) {
    logger.error(err);
    return null;
  }
}

const findFloorPrice = async (stat: any): Promise<number> => {
  const url = `https://api.seize.io/floor_price?contract=${stat.contract}&id=${stat.id}`;
  const res = await getResult(url);

  if (res && res.status === 200) {
    const response: any = await res.json();
    let floorPrice = 0;
    if (response.orders && response.orders.length > 0) {
      floorPrice = response.orders[0].current_price;
    }
    return parseFloat(Utils.formatEther(floorPrice));
  } else {
    logger.error(
      `error [TOKEN ID ${stat.id}] ${url} ${res?.status} ${
        res?.statusText
      } ${JSON.stringify(res)}`
    );
    logger.info(`${stat.id} Retrying in 3 seconds....`);
    await delay(3000);
    logger.info(`${stat.id} Retrying now....`);
    return await findFloorPrice(stat);
  }
};

export const findNftMarketStats = async (contract: string) => {
  if (areEqualAddresses(contract, MEMELAB_CONTRACT)) {
    await findNftMarketStatsLab();
  } else {
    await findNftMarketStatsMain(contract);
  }
};

const findNftMarketStatsMain = async (contract: string) => {
  const nfts: NFT[] = await fetchNftsForContract(contract, 'id desc');

  logger.info(
    `[CONTRACT ${contract}] [PROCESSING STATS FOR ${nfts.length} NFTS]`
  );

  const processedStats: NFT[] = [];

  for (let i = 0; i < nfts.length; i++) {
    const nft = nfts[i];

    const floorPrice = await findFloorPrice(nft);
    if (floorPrice) {
      const volumes = await findVolumeNFTs(nft);

      nft.floor_price = floorPrice;
      nft.market_cap = floorPrice * nft.supply;
      nft.total_volume_last_24_hours = volumes.total_volume_last_24_hours;
      nft.total_volume_last_7_days = volumes.total_volume_last_7_days;
      nft.total_volume_last_1_month = volumes.total_volume_last_1_month;
      nft.total_volume = volumes.total_volume;

      await persistNFTs([nft]);
      logger.info(`[CONTRACT ${contract}] [PROCESSED FOR ID ${nft.id}]`);
    } else {
      logger.info(`[CONTRACT ${contract}] [ID ${nft.id}] [NO RESULTS FOUND]`);
    }
    processedStats.push(nft);
  }

  logger.info(`[PROCESSED ASSETS FOR ${processedStats.length} NFTS]`);

  return processedStats;
};

const findNftMarketStatsLab = async () => {
  const nfts: LabNFT[] = await fetchAllMemeLabNFTs('id desc');

  logger.info(`[MEME LAB] [PROCESSING STATS FOR ${nfts.length} NFTS]`);

  const processedStats: LabNFT[] = [];

  for (let i = 0; i < nfts.length; i++) {
    const nft = nfts[i];

    const floorPrice = await findFloorPrice(nft);
    const volumes = await findVolumeLab(nft);

    nft.floor_price = floorPrice;
    nft.market_cap = floorPrice * nft.supply;
    nft.total_volume_last_24_hours = volumes.total_volume_last_24_hours;
    nft.total_volume_last_7_days = volumes.total_volume_last_7_days;
    nft.total_volume_last_1_month = volumes.total_volume_last_1_month;
    nft.total_volume = volumes.total_volume;

    await persistLabNFTS([nft]);
    logger.info(`[MEME LAB] [PROCESSED FOR ID ${nft.id}]`);
    processedStats.push(nft);
  }

  logger.info(`[PROCESSED ASSETS FOR ${processedStats.length} NFTS]`);
  return processedStats;
};
