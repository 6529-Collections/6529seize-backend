import { ethers } from 'ethers';
import axios from 'axios';
import { getRpcProvider } from '../rpc-provider';
import {
  getDataSource,
  fetchAllArtists,
  persistArtists,
  fetchMemesWithSeason
} from '../db';
import { NFT, LabNFT, NFTWithExtendedData, BaseNFT } from '../entities/INFT';
import { NFTOwner } from '../entities/INFTOwner';
import { TokenType } from '../enums';
import { Logger } from '../logging';
import {
  MEMES_CONTRACT,
  MEME_8_EDITION_BURN_ADJUSTMENT,
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  NFT_HTML_LINK,
  NFT_ORIGINAL_IMAGE_LINK,
  NFT_SCALED60_IMAGE_LINK,
  NFT_SCALED450_IMAGE_LINK,
  NFT_SCALED1000_IMAGE_LINK,
  NFT_VIDEO_LINK,
  MANIFOLD,
  NULL_ADDRESS
} from '../constants';
import { areEqualAddresses, replaceEmojisWithHex } from '../helpers';
import { processArtists } from '../artists';
import { Transaction } from '../entities/ITransaction';
import { In, MoreThan } from 'typeorm';

const logger = Logger.get('nfts');

export enum NFT_MODE {
  DISCOVER = 'discover',
  REFRESH = 'refresh'
}

const URI_ABI = [
  'function tokenURI(uint256 tokenId) public view returns (string)',
  'function uri(uint256 tokenId) public view returns (string)'
];

const contractInstances = new Map<string, ethers.Contract>();
function getContractInstance(
  contract: string,
  provider: ethers.providers.JsonRpcProvider
) {
  const key = ethers.utils.getAddress(contract);
  if (!contractInstances.has(key)) {
    contractInstances.set(key, new ethers.Contract(key, URI_ABI, provider));
  }
  return contractInstances.get(key)!;
}

function getTokenPath(contract: string, tokenId: number, format: string) {
  return format.toUpperCase() === 'GIF'
    ? `${contract}/${tokenId}.${format}`
    : `${contract}/${tokenId}.WEBP`;
}

function getAnimationPaths(
  contract: string,
  tokenId: number,
  animationDetails: any
) {
  const parsed =
    typeof animationDetails === 'string'
      ? JSON.parse(animationDetails)
      : animationDetails;
  if (!parsed) return {};
  const ext = parsed.format;
  const base = `${contract}/${tokenId}.${ext}`;
  if (ext === 'HTML') {
    return { animation: `${NFT_HTML_LINK}${base}` };
  } else if (['MP4', 'MOV'].includes(ext)) {
    return {
      animation: `${NFT_VIDEO_LINK}${base}`,
      compressedAnimation: `${NFT_VIDEO_LINK}${contract}/scaledx750/${tokenId}.${ext}`
    };
  }
  return {};
}

function isValidUrl(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || uri.startsWith('ipfs://');
  } catch {
    return false;
  }
}

async function fetchMetadata(uri: string): Promise<any> {
  try {
    const url = uri.startsWith('ipfs://')
      ? uri.replace('ipfs://', 'https://ipfs.6529.io/ipfs/')
      : uri;
    const res = await axios.get(url, { timeout: 10000 });
    return res.data;
  } catch (err: any) {
    logger.warn(`❌ Failed to fetch metadata from ${uri}: ${err.message}`);
    return null;
  }
}

interface ContractConfig {
  contract: string;
  tokenType: TokenType;
  collection: string;
  artist?: string;
  artistSeizeHandle?: string;
}

const NFT_CONTRACTS: ContractConfig[] = [
  {
    contract: MEMES_CONTRACT,
    tokenType: TokenType.ERC1155,
    collection: 'The Memes by 6529'
  },
  {
    contract: GRADIENT_CONTRACT,
    tokenType: TokenType.ERC721,
    collection: '6529 Gradient',
    artist: '6529er',
    artistSeizeHandle: '6529er'
  }
];

const LABNFT_CONTRACTS: ContractConfig[] = [
  {
    contract: MEMELAB_CONTRACT,
    tokenType: TokenType.ERC1155,
    collection: 'Meme Lab by 6529'
  }
];

async function processNFTsForType(
  EntityClass: typeof NFT | typeof LabNFT,
  contracts: ContractConfig[],
  mode: NFT_MODE,
  provider: ethers.providers.JsonRpcProvider,
  updateHodlRate: boolean
) {
  const repo = getDataSource().getRepository(EntityClass);
  const existing = await repo.find();
  const nftMap = new Map<string, { nft: any; changed: boolean }>();

  existing.forEach((n) =>
    nftMap.set(`${n.contract.toLowerCase()}-${n.id}`, {
      nft: n,
      changed: false
    })
  );

  const contractMap = new Map<string, number>();
  for (const nft of existing) {
    const maxId = contractMap.get(nft.contract) ?? -1;
    if (nft.id > maxId) contractMap.set(nft.contract, nft.id);
  }

  if (mode === NFT_MODE.DISCOVER) {
    await discoverNewNFTs(
      contracts,
      contractMap,
      nftMap,
      provider,
      EntityClass
    );
  } else {
    await refreshExistingNFTs(nftMap, provider);
  }

  await updateSupply(nftMap, updateHodlRate);

  const toSave = Array.from(nftMap.values())
    .filter((entry) => entry.changed)
    .map((entry) => entry.nft);

  if (toSave.length > 0) {
    await repo.save(toSave);
    logger.info(`✅ Saved ${toSave.length} ${EntityClass.name}s`);

    const artists = await fetchAllArtists();
    const newArtists = await processArtists(artists, toSave);
    await persistArtists(newArtists);
  } else {
    logger.info(`✅ No changes detected for ${EntityClass.name}s`);
  }
}

async function discoverNewNFTs(
  contracts: ContractConfig[],
  contractMap: Map<string, number>,
  nftMap: Map<string, { nft: any; changed: boolean }>,
  provider: ethers.providers.JsonRpcProvider,
  EntityClass: typeof NFT | typeof LabNFT
) {
  const memeNFTs: NFTWithExtendedData[] =
    EntityClass === LabNFT ? await fetchMemesWithSeason() : [];

  await Promise.all(
    contracts.map(async (config) => {
      const contract = config.contract;
      const instance = getContractInstance(contract, provider);
      const method = config.tokenType === TokenType.ERC721 ? 'tokenURI' : 'uri';

      let nextId = (contractMap.get(contract) ?? -1) + 1;
      if (config.tokenType === TokenType.ERC1155 && !nextId) nextId = 1;

      while (true) {
        try {
          const uri = await instance[method](nextId);
          if (!isValidUrl(uri)) throw new Error('Invalid URI');

          const metadata = await fetchMetadata(uri);
          if (!metadata) throw new Error('Invalid Metadata');

          const format = metadata.image_details?.format ?? 'WEBP';
          const tokenPathOriginal = `${contract}/${nextId}.${format}`;
          const tokenPath = getTokenPath(contract, nextId, format);
          const { animation, compressedAnimation } = getAnimationPaths(
            contract,
            nextId,
            metadata.animation_details
          );

          const artist =
            metadata.attributes?.find((a: any) => a.trait_type === 'Artist')
              ?.value ??
            config.artist ??
            '';
          const artistSeizeHandle =
            metadata.attributes?.find(
              (a: any) => a.trait_type?.toUpperCase() === 'SEIZE ARTIST PROFILE'
            )?.value ??
            config.artistSeizeHandle ??
            '';

          const mintPrice = await getMintPrice(contract, nextId);
          const mintDate = await getMintDate(contract, nextId);

          const baseNft: any = {
            id: nextId,
            contract,
            created_at: new Date(),
            mint_date: mintDate,
            mint_price: mintPrice,
            supply: config.tokenType === TokenType.ERC721 ? 1 : 0,
            name: metadata.name,
            collection: config.collection,
            token_type: config.tokenType,
            description: replaceEmojisWithHex(metadata.description),
            artist,
            artist_seize_handle: artistSeizeHandle,
            uri,
            icon: `${NFT_SCALED60_IMAGE_LINK}${tokenPath}`,
            thumbnail: `${NFT_SCALED450_IMAGE_LINK}${tokenPath}`,
            scaled: `${NFT_SCALED1000_IMAGE_LINK}${tokenPath}`,
            image: `${NFT_ORIGINAL_IMAGE_LINK}${tokenPathOriginal}`,
            compressed_animation: compressedAnimation,
            animation: animation,
            metadata,
            floor_price: 0,
            floor_price_from: null,
            market_cap: 0,
            total_volume_last_24_hours: 0,
            total_volume_last_7_days: 0,
            total_volume_last_1_month: 0,
            total_volume: 0,
            highest_offer: 0,
            highest_offer_from: null
          };

          if (EntityClass === LabNFT) {
            baseNft.meme_references = extractMemeRefs(metadata, memeNFTs);
          } else {
            baseNft.hodl_rate = 0;
            baseNft.boosted_tdh = 0;
            baseNft.tdh = 0;
            baseNft.tdh__raw = 0;
            baseNft.tdh_rank = 0;
          }

          nftMap.set(`${contract.toLowerCase()}-${nextId}`, {
            nft: Object.assign(new EntityClass(), baseNft),
            changed: true
          });

          logger.info(`🆕 Discovered token for ${contract} #${nextId}: ${uri}`);
          nextId++;
        } catch (err: any) {
          const msg = err.message.toLowerCase();
          if (
            msg.includes('invalid uri') ||
            msg.includes('invalid token') ||
            msg.includes('nonexistent token') // error from erc721
          ) {
            logger.info(
              `🔚 Stopping Discovery for ${config.contract} at #${nextId}`
            );
            if (config.tokenType === TokenType.ERC1155 && !nextId) {
              nextId = 1;
              continue;
            } else {
              break;
            }
          } else {
            throw err;
          }
        }
      }
    })
  );
}

function extractMemeRefs(
  metadata: any,
  memes: NFTWithExtendedData[]
): number[] {
  const refs: number[] = [];
  metadata.attributes?.forEach((a: any) => {
    const trait = a.trait_type?.toUpperCase();
    const val = a.value?.toString().toUpperCase();
    if (!trait?.startsWith('MEME CARD REFERENCE') || val === 'NONE') return;

    if (val === 'ALL') {
      refs.push(...memes.map((m) => m.id));
    } else if (val.startsWith('ALL SZN')) {
      const season = parseInt(val.split('SZN')[1], 10);
      if (!isNaN(season)) {
        refs.push(...memes.filter((m) => m.season === season).map((m) => m.id));
      }
    } else {
      const match = memes.find((m) => m.name?.toUpperCase() === val);
      if (match) refs.push(match.id);
    }
  });
  return refs;
}

async function refreshExistingNFTs(
  nftMap: Map<string, { nft: BaseNFT; changed: boolean }>,
  provider: ethers.providers.JsonRpcProvider
) {
  await Promise.all(
    Array.from(nftMap.values()).map(async (entry) => {
      const { nft } = entry;
      const contract = getContractInstance(nft.contract, provider);
      const method = nft.token_type === TokenType.ERC721 ? 'tokenURI' : 'uri';

      try {
        const uri = await contract[method](nft.id);
        if ((uri && uri !== nft.uri && isValidUrl(uri)) || !nft.metadata) {
          const metadata = await fetchMetadata(uri);
          if (metadata) {
            nft.uri = uri;
            nft.metadata = metadata;
            entry.changed = true;
            logger.info(`♻️ ${nft.contract} #${nft.id} refreshed URI`);
          }
        }
        if (!nft.mint_date) {
          logger.info(
            `🔄 ${nft.contract} #${nft.id} missing mint date, fetching...`
          );
          const mintDate = await getMintDate(nft.contract, nft.id);
          if (mintDate) {
            logger.info(
              `🔄 ${nft.contract} #${nft.id} mint date updated to ${mintDate}`
            );
            nft.mint_date = mintDate;
            entry.changed = true;
          } else {
            logger.warn(`⚠️ ${nft.contract} #${nft.id} mint date not found`);
          }
        }
        if (!nft.mint_price) {
          const mintPrice = await getMintPrice(nft.contract, nft.id);
          if (mintPrice) {
            logger.info(
              `🔄 ${nft.contract} #${nft.id} mint price updated to ${mintPrice}`
            );
            nft.mint_price = mintPrice;
            entry.changed = true;
          }
        }
      } catch (err: any) {
        logger.warn(
          `⚠️ ${nft.contract} #${nft.id} refresh failed: ${err.message}`
        );
      }
    })
  );
}

async function updateSupply(
  nftMap: Map<string, { nft: any; changed: boolean }>,
  updateHodlRate: boolean
) {
  let maxSupply = 0;

  await Promise.all(
    Array.from(nftMap.values()).map(async (entry) => {
      const nft = entry.nft;
      let supply = 0;

      if (nft.token_type === TokenType.ERC1155) {
        supply = await getDataSource()
          .getRepository(NFTOwner)
          .createQueryBuilder('owner')
          .select('SUM(owner.balance)', 'sum')
          .where('owner.contract = :contract', { contract: nft.contract })
          .andWhere('owner.token_id = :token_id', { token_id: nft.id })
          .getRawOne()
          .then((res) => Number(res?.sum ?? 0));

        if (areEqualAddresses(nft.contract, MEMES_CONTRACT) && nft.id === 8) {
          supply += MEME_8_EDITION_BURN_ADJUSTMENT;
        }
      } else {
        supply = Array.from(nftMap.values()).filter((e) =>
          areEqualAddresses(e.nft.contract, nft.contract)
        ).length;
      }

      if (supply !== nft.supply) {
        nft.supply = supply;
        entry.changed = true;
        logger.info(
          `🔄 ${nft.contract} #${nft.id} supply updated to ${supply}`
        );
      }

      maxSupply = Math.max(maxSupply, supply);
    })
  );

  if (updateHodlRate) {
    nftMap.forEach((entry) => {
      const nft = entry.nft;
      let newRate = maxSupply / nft.supply;
      if (!isFinite(newRate) || newRate < 1) newRate = 1;
      if (nft.hodl_rate !== newRate) {
        nft.hodl_rate = newRate;
        entry.changed = true;
        logger.info(
          `🔄 ${nft.contract} #${nft.id} hodl rate updated to ${newRate}`
        );
      }
    });
  }
}

const getMintPrice = async (contract: string, tokenId: number) => {
  const repo = getDataSource().getRepository(Transaction);
  const firstMintTransaction = await repo.findOne({
    where: {
      contract,
      token_id: tokenId,
      from_address: In([NULL_ADDRESS, MANIFOLD]),
      value: MoreThan(0)
    },
    order: { transaction_date: 'ASC' }
  });
  return firstMintTransaction?.value ?? 0;
};

const getMintDate = async (contract: string, tokenId: number) => {
  const repo = getDataSource().getRepository(Transaction);
  const firstTransaction = await repo.findOne({
    where: {
      contract,
      token_id: tokenId,
      from_address: In([NULL_ADDRESS, MANIFOLD])
    },
    order: { transaction_date: 'ASC' }
  });
  return firstTransaction?.transaction_date;
};

export async function processNFTs(mode: NFT_MODE) {
  const provider = getRpcProvider();
  await processNFTsForType(NFT, NFT_CONTRACTS, mode, provider, true);
  await processNFTsForType(LabNFT, LABNFT_CONTRACTS, mode, provider, false);
}
