import { Alchemy, Nft, Utils } from 'alchemy-sdk';
import {
  ALCHEMY_SETTINGS,
  GRADIENT_CONTRACT,
  MANIFOLD,
  MEMES_CONTRACT,
  NFT_HTML_LINK,
  NFT_ORIGINAL_IMAGE_LINK,
  NFT_SCALED1000_IMAGE_LINK,
  NFT_SCALED450_IMAGE_LINK,
  NFT_SCALED60_IMAGE_LINK,
  NFT_VIDEO_LINK,
  NFTS_TABLE,
  NULL_ADDRESS
} from '../constants';
import { NFT } from '../entities/INFT';
import { Transaction } from '../entities/ITransaction';
import {
  areEqualAddresses,
  isNullAddress,
  replaceEmojisWithHex
} from '../helpers';
import {
  fetchAllNFTs,
  fetchAllTransactions,
  fetchAllArtists,
  persistArtists,
  persistNFTs
} from '../db';
import { processArtists } from '../artists';
import { Artist } from '../entities/IArtist';
import { RequestInfo, RequestInit } from 'node-fetch';
import { sqlExecutor } from '../sql-executor';
import { Logger } from '../logging';

const logger = Logger.get('NFTS');

const fetch = (url: RequestInfo, init?: RequestInit) =>
  import('node-fetch').then(({ default: fetch }) => fetch(url, init));

let alchemy: Alchemy;

export async function getNFTResponse(
  alchemy: Alchemy,
  contract: string,
  key: any
) {
  const settings = {
    pageKey: undefined
  };

  if (key) {
    settings.pageKey = key;
  }

  const response = await alchemy.nft.getNftsForContract(contract, settings);
  return response;
}

async function getAllNFTs(
  contract: string,
  nfts: Nft[] = [],
  key = ''
): Promise<Nft[]> {
  const response = await getNFTResponse(alchemy, contract, key);
  const newKey = response.pageKey;
  nfts = nfts.concat(response.nfts);

  if (newKey) {
    return getAllNFTs(contract, nfts, newKey);
  }

  return nfts;
}

const fetchTokenMetadata = async (tokenId: number, tokenUri: string) => {
  const response = await fetch(tokenUri);
  return response.json();
};

const calculateMintPrice = async (firstMintTransaction: Transaction | null) => {
  if (!firstMintTransaction) return 0;
  const mintTransaction = await alchemy.core.getTransaction(
    firstMintTransaction.transaction
  );
  if (!mintTransaction) return 0;
  return (
    parseFloat(Utils.formatEther(mintTransaction.value)) /
    firstMintTransaction.token_count
  );
};

const calculateSupply = (
  createdTransactions: Transaction[],
  burntTransactions: Transaction[]
) => {
  let supply = createdTransactions.reduce(
    (acc, mint) => acc + mint.token_count,
    0
  );
  supply -= burntTransactions.reduce((acc, burn) => acc + burn.token_count, 0);
  return supply;
};

const getAnimationPaths = (tokenId: number, animationDetails: any) => {
  let animation, compressedAnimation;
  if (animationDetails) {
    const basePath = `${NFT_VIDEO_LINK}${MEMES_CONTRACT}/${tokenId}`;
    switch (animationDetails.format) {
      case 'MP4':
      case 'MOV':
        animation = `${basePath}.${animationDetails.format}`;
        compressedAnimation = `${basePath}/scaledx750.${animationDetails.format}`;
        break;
      case 'HTML':
        animation = `${NFT_HTML_LINK}${MEMES_CONTRACT}/${tokenId}.${animationDetails.format}`;
        break;
    }
  }
  return { animation, compressedAnimation };
};

const getTokenPath = (contract: string, tokenId: number, format: string) => {
  return format.toUpperCase() === 'GIF'
    ? `${contract}/${tokenId}.${format}`
    : `${contract}/${tokenId}.WEBP`;
};

async function processMemes(startingNFTS: NFT[], transactions: Transaction[]) {
  const startingMemes = [...startingNFTS].filter((nft) =>
    areEqualAddresses(nft.contract, MEMES_CONTRACT)
  );

  const allMemesNFTS = await getAllNFTs(MEMES_CONTRACT);

  logger.info(
    `[MEMES] [DB ${startingMemes.length}] [CONTRACT ${allMemesNFTS.length}]`
  );

  const newNFTS: NFT[] = [];

  await Promise.all(
    allMemesNFTS.map(async (mnft) => {
      const tokenId = parseInt(mnft.tokenId);
      const fullMetadata = await fetchTokenMetadata(
        tokenId,
        mnft.raw.tokenUri!
      );

      const format = fullMetadata.image_details.format;
      const tokenPathOriginal = `${MEMES_CONTRACT}/${tokenId}.${format}`;

      const { createdTransactions, burntTransactions, firstMintTransaction } =
        transactions.reduce(
          (acc, t) => {
            if (
              t.token_id == tokenId &&
              areEqualAddresses(t.contract, MEMES_CONTRACT)
            ) {
              if (areEqualAddresses(NULL_ADDRESS, t.from_address))
                acc.createdTransactions.push(t);
              if (isNullAddress(t.to_address)) acc.burntTransactions.push(t);
              if (
                !acc.firstMintTransaction &&
                t.value > 0 &&
                (areEqualAddresses(MANIFOLD, t.from_address) ||
                  areEqualAddresses(NULL_ADDRESS, t.from_address))
              ) {
                acc.firstMintTransaction = t;
              }
            }
            return acc;
          },
          {
            createdTransactions: [] as Transaction[],
            burntTransactions: [] as Transaction[],
            firstMintTransaction: null as Transaction | null
          }
        );

      const mintPrice = await calculateMintPrice(firstMintTransaction);
      const supply = calculateSupply(createdTransactions, burntTransactions);
      const tokenPath = getTokenPath(
        MEMES_CONTRACT,
        tokenId,
        fullMetadata.image_details.format
      );
      const { animation, compressedAnimation } = getAnimationPaths(
        tokenId,
        typeof fullMetadata.animation_details === 'string'
          ? JSON.parse(fullMetadata.animation_details)
          : fullMetadata.animation_details
      );

      const startingNft = startingNFTS.find(
        (s) => s.id == tokenId && areEqualAddresses(s.contract, MEMES_CONTRACT)
      );

      const nft: NFT = {
        id: tokenId,
        contract: MEMES_CONTRACT,
        created_at: new Date(),
        mint_date: new Date(
          createdTransactions[0]
            ? createdTransactions[0].transaction_date
            : new Date()
        ),
        mint_price: mintPrice,
        supply: supply,
        name: fullMetadata.name,
        collection: 'The Memes by 6529',
        token_type: 'ERC1155',
        hodl_rate: 0,
        description: replaceEmojisWithHex(fullMetadata.description),
        artist: fullMetadata.attributes?.find(
          (a: any) => a.trait_type === 'Artist'
        )?.value,
        artist_seize_handle:
          fullMetadata.attributes?.find(
            (a: any) => a.trait_type.toUpperCase() === 'SEIZE ARTIST PROFILE'
          )?.value ?? '',
        uri: fullMetadata.tokenUri?.raw,
        icon: `${NFT_SCALED60_IMAGE_LINK}${tokenPath}`,
        thumbnail: `${NFT_SCALED450_IMAGE_LINK}${tokenPath}`,
        scaled: `${NFT_SCALED1000_IMAGE_LINK}${tokenPath}`,
        image: `${NFT_ORIGINAL_IMAGE_LINK}${tokenPathOriginal}`,
        compressed_animation: compressedAnimation,
        animation: animation,
        metadata: fullMetadata,
        boosted_tdh: startingNft ? startingNft.boosted_tdh : 0,
        tdh: startingNft ? startingNft.tdh : 0,
        tdh__raw: startingNft ? startingNft.tdh__raw : 0,
        tdh_rank: startingNft ? startingNft.tdh_rank : 0,
        floor_price: startingNft ? startingNft.floor_price : 0,
        market_cap: startingNft ? startingNft.market_cap : 0,
        total_volume_last_24_hours: startingNft
          ? startingNft.total_volume_last_24_hours
          : 0,
        total_volume_last_7_days: startingNft
          ? startingNft.total_volume_last_7_days
          : 0,
        total_volume_last_1_month: startingNft
          ? startingNft.total_volume_last_1_month
          : 0,
        total_volume: startingNft ? startingNft.total_volume : 0
      };

      newNFTS.push(nft);
    })
  );

  logger.info(`[MEMES] [PROCESSED ${newNFTS.length} NEW NFTS]`);
  return newNFTS;
}

async function processGradients(
  startingNFTS: NFT[],
  transactions: Transaction[]
) {
  const startingGradients = [...startingNFTS].filter((nft) =>
    areEqualAddresses(nft.contract, GRADIENT_CONTRACT)
  );

  const allGradientsNFTS = await getAllNFTs(GRADIENT_CONTRACT);

  logger.info(
    `[GRADIENTS] [DB ${startingGradients.length}] [CONTRACT ${allGradientsNFTS.length}]`
  );

  const newNFTS: NFT[] = [];
  const fetchAndPrepareMetadata = async (tokenUri: string) => {
    const fullMetadata = await fetch(tokenUri).then((response) =>
      response.json()
    );
    const format = fullMetadata.image
      ? fullMetadata.image.split('.').pop()
      : 'WEBP';
    return { fullMetadata, format };
  };

  const processGradientNFT = async (gnft: Nft, transactions: Transaction[]) => {
    const tokenId = parseInt(gnft.tokenId);
    const { fullMetadata, format } = await fetchAndPrepareMetadata(
      gnft.raw.tokenUri!
    );

    if (!fullMetadata.image) return;

    const createdTransactions = transactions.filter(
      (t) =>
        t.token_id == tokenId &&
        areEqualAddresses(t.contract, GRADIENT_CONTRACT) &&
        areEqualAddresses(NULL_ADDRESS, t.from_address)
    );

    const supply = allGradientsNFTS.length;
    const tokenPath = getTokenPath(GRADIENT_CONTRACT, tokenId, format);
    const tokenPathOriginal = `${GRADIENT_CONTRACT}/${tokenId}.${format}`;

    const startingNft = startingNFTS.find(
      (s) =>
        s.id === tokenId && areEqualAddresses(s.contract, GRADIENT_CONTRACT)
    );

    const nft: NFT = {
      id: tokenId,
      contract: GRADIENT_CONTRACT,
      created_at: new Date(),
      mint_date: new Date(createdTransactions[0].transaction_date),
      mint_price: 0,
      supply: supply,
      name: fullMetadata?.name,
      collection: '6529 Gradient',
      token_type: 'ERC721',
      hodl_rate: 0,
      description: replaceEmojisWithHex(fullMetadata.description),
      artist: '6529er',
      artist_seize_handle: '6529er',
      uri: fullMetadata.tokenUri?.raw,
      icon: `${NFT_SCALED60_IMAGE_LINK}${tokenPath}`,
      thumbnail: `${NFT_SCALED450_IMAGE_LINK}${tokenPath}`,
      scaled: `${NFT_SCALED1000_IMAGE_LINK}${tokenPath}`,
      image: `${NFT_ORIGINAL_IMAGE_LINK}${tokenPathOriginal}`,
      animation: undefined,
      metadata: fullMetadata,
      boosted_tdh: startingNft ? startingNft.boosted_tdh : 0,
      tdh: startingNft ? startingNft.tdh : 0,
      tdh__raw: startingNft ? startingNft.tdh__raw : 0,
      tdh_rank: startingNft ? startingNft.tdh_rank : 0,
      floor_price: startingNft ? startingNft.floor_price : 0,
      market_cap: startingNft ? startingNft.market_cap : 0,
      total_volume_last_24_hours: startingNft
        ? startingNft.total_volume_last_24_hours
        : 0,
      total_volume_last_7_days: startingNft
        ? startingNft.total_volume_last_7_days
        : 0,
      total_volume_last_1_month: startingNft
        ? startingNft.total_volume_last_1_month
        : 0,
      total_volume: startingNft ? startingNft.total_volume : 0
    };

    newNFTS.push(nft);
  };

  await Promise.all(
    allGradientsNFTS.map((gnft) => processGradientNFT(gnft, transactions))
  );

  logger.info(`[GRADIENTS] [PROCESSED ${newNFTS.length} NEW NFTS]`);
  return newNFTS;
}

export const discoverNFTs = async (
  startingNFTS: NFT[],
  transactions: Transaction[],
  reset?: boolean
) => {
  const newMemes = await processMemes(startingNFTS, transactions);
  const newGradients = await processGradients(startingNFTS, transactions);

  const allNewNFTS = newMemes.concat(newGradients);

  let GLOBAL_HODL_INDEX_TOKEN = startingNFTS.find((a) => a.hodl_rate == 1);
  const NEW_TOKENS_HODL_INDEX = Math.max(...allNewNFTS.map((o) => o.supply));
  const nftChanged = allNewNFTS.some((n) => {
    const m = startingNFTS.find(
      (s) => areEqualAddresses(s.contract, n.contract) && s.id == n.id
    );
    if (m?.mint_price != n.mint_price) {
      return true;
    }
    if (m?.supply != n.supply) {
      return true;
    }
    if (m.uri != n.uri) {
      return true;
    }
    if (new Date(m?.mint_date).getTime() != new Date(n.mint_date).getTime()) {
      return true;
    }
    return false;
  });

  logger.info(`[CHANGED ${nftChanged}] [RESET ${reset}]`);

  if (
    reset ||
    nftChanged ||
    allNewNFTS.length > startingNFTS.length ||
    !GLOBAL_HODL_INDEX_TOKEN ||
    NEW_TOKENS_HODL_INDEX > GLOBAL_HODL_INDEX_TOKEN.supply
  ) {
    const allNFTS = allNewNFTS;
    logger.info(
      `[HODL INDEX CHANGED] [DB ${GLOBAL_HODL_INDEX_TOKEN?.supply}] [NEW ${NEW_TOKENS_HODL_INDEX}] [RECALCULATING]`
    );
    allNFTS.forEach((t) => {
      if (
        !GLOBAL_HODL_INDEX_TOKEN ||
        t.supply > GLOBAL_HODL_INDEX_TOKEN.supply
      ) {
        GLOBAL_HODL_INDEX_TOKEN = t;
      }
    });
    logger.info(
      `[GLOBAL_HODL_INDEX_TOKEN SUPPLY ${GLOBAL_HODL_INDEX_TOKEN!.supply}]`
    );
    allNFTS.forEach((t) => {
      const hodl = GLOBAL_HODL_INDEX_TOKEN!.supply / t.supply;
      t.hodl_rate = isFinite(hodl) ? hodl : 1;
    });
    logger.info(`[HODL INDEX UPDATED]`);
    return allNFTS;
  } else {
    logger.info(
      `[NO NEW NFTS] [DB HODL_INDEX ${GLOBAL_HODL_INDEX_TOKEN?.supply}] [END]`
    );
    return startingNFTS;
  }
};

export async function nfts(reset?: boolean) {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const nfts: NFT[] = await fetchAllNFTs();
  const transactions: Transaction[] = await fetchAllTransactions();
  const artists: Artist[] = await fetchAllArtists();

  const newNfts = await discoverNFTs(nfts, transactions, reset);
  const newArtists = await processArtists(artists, newNfts);
  await persistNFTs(newNfts);
  await persistArtists(newArtists);
}

export async function getMemeThumbnailUriById(
  id: number
): Promise<string | undefined> {
  const result = await sqlExecutor.execute(
    `select thumbnail from ${NFTS_TABLE} where id = :id and contract = :contract order by id asc limit 1`,
    {
      id,
      contract: MEMES_CONTRACT
    }
  );
  return result.at(0)?.thumbnail;
}
