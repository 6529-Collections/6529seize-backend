import {
  GRADIENT_CONTRACT,
  MANIFOLD,
  MEME_8_EDITION_BURN_ADJUSTMENT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  NFT_HTML_LINK,
  NFT_ORIGINAL_IMAGE_LINK,
  NFT_SCALED1000_IMAGE_LINK,
  NFT_SCALED450_IMAGE_LINK,
  NFT_SCALED60_IMAGE_LINK,
  NFT_VIDEO_LINK,
  NULL_ADDRESS
} from '@/constants';
import { deployerDropper } from '@/deployer-dropper';
import { env } from '@/env';
import { processArtists } from '@/artists';
import {
  deleteArtistsNotIn,
  fetchAllArtists,
  fetchMemesWithSeason,
  getDataSource,
  persistArtists
} from '@/db';
import { MemesMintStat } from '@/entities/IMemesMintStat';
import { LabNFT, NFT, NFTWithExtendedData } from '@/entities/INFT';
import { NFTOwner } from '@/entities/INFTOwner';
import { RedeemedSubscription } from '@/entities/ISubscription';
import { Transaction } from '@/entities/ITransaction';
import { TokenType } from '@/enums';
import { Logger } from '@/logging';
import { getRpcProvider } from '@/rpc-provider';
import { equalIgnoreCase } from '@/strings';
import { text } from '@/text';
import { Time } from '@/time';
import axios from 'axios';
import { ethers } from 'ethers';
import { In, MoreThan, Not, Repository } from 'typeorm';

const logger = Logger.get('nfts');

const MINT_DATE_GRACE_PERIOD_DAYS = 7;
const MEMES_MINT_STATS_CLOSE_HOUR = 17;

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
  provider: ethers.JsonRpcProvider
) {
  const key = ethers.getAddress(contract);
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
  provider: ethers.JsonRpcProvider,
  updateHodlRate: boolean
) {
  const repo = getDataSource().getRepository(EntityClass);
  const existing = await repo.find();
  const nftMap = new Map<string, { nft: NFT | LabNFT; changed: boolean }>();
  const newlyDiscoveredNfts: Array<NFT | LabNFT> = [];

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
    logger.info(`🔍 Discovering new ${EntityClass.name}s`);
    await discoverNewNFTs(
      contracts,
      contractMap,
      nftMap,
      provider,
      EntityClass,
      newlyDiscoveredNfts
    );
  } else {
    logger.info(`🔄 Refreshing existing ${EntityClass.name}s`);
    await refreshExistingNFTs(nftMap, provider);
    await populateMintStatsForEligibleNFTs(nftMap);
  }

  logger.info(`🔄 Updating supply for ${EntityClass.name}s`);
  await updateSupply(nftMap, updateHodlRate);

  await updateMemeReferences(nftMap, EntityClass);

  const toSave = Array.from(nftMap.values())
    .filter((entry) => entry.changed)
    .map((entry) => entry.nft);

  if (toSave.length > 0) {
    await repo.save(toSave);
    logger.info(`✅ Saved ${toSave.length} ${EntityClass.name}s`);

    if (mode === NFT_MODE.DISCOVER && EntityClass === NFT) {
      try {
        await announceNewMemeDiscoveries(newlyDiscoveredNfts as NFT[]);
      } catch (error: any) {
        logger.error(
          `announceNewMemeDiscoveries failed: ${error?.message ?? String(error)}`
        );
      }
    }
  } else {
    logger.info(`✅ No changes detected for ${EntityClass.name}s`);
  }
}

async function discoverNewNFTs(
  contracts: ContractConfig[],
  contractMap: Map<string, number>,
  nftMap: Map<string, { nft: NFT | LabNFT; changed: boolean }>,
  provider: ethers.JsonRpcProvider,
  EntityClass: typeof NFT | typeof LabNFT,
  newlyDiscoveredNfts: Array<NFT | LabNFT>
) {
  await Promise.all(
    contracts.map((config) =>
      discoverForContract(
        config,
        contractMap,
        nftMap,
        provider,
        EntityClass,
        newlyDiscoveredNfts
      )
    )
  );
}

async function discoverForContract(
  config: ContractConfig,
  contractMap: Map<string, number>,
  nftMap: Map<string, { nft: NFT | LabNFT; changed: boolean }>,
  provider: ethers.JsonRpcProvider,
  EntityClass: typeof NFT | typeof LabNFT,
  newlyDiscoveredNfts: Array<NFT | LabNFT>
) {
  const { contract, tokenType } = config;
  const instance = getContractInstance(contract, provider);
  const method = tokenType === TokenType.ERC721 ? 'tokenURI' : 'uri';
  let nextId = (contractMap.get(contract) ?? -1) + 1;
  if (tokenType === TokenType.ERC1155 && !nextId) nextId = 1;

  while (true) {
    try {
      const uri = await instance[method](nextId);
      validateUri(uri);

      const metadata = await fetchMetadata(uri);
      validateMetadata(metadata);

      const baseNft = await buildBaseNft(
        contract,
        nextId,
        tokenType,
        config,
        metadata,
        EntityClass
      );

      const discoveredNft = Object.assign(new EntityClass(), baseNft);
      nftMap.set(`${contract.toLowerCase()}-${nextId}`, {
        nft: discoveredNft,
        changed: true
      });
      newlyDiscoveredNfts.push(discoveredNft);

      logger.info(`🆕 Discovered token for ${contract} #${nextId}: ${uri}`);
      nextId++;
    } catch (err: any) {
      if (shouldStopDiscovery(err.message)) {
        logger.info(`🔚 Stopping Discovery for ${contract} at #${nextId}`);
        if (tokenType === TokenType.ERC1155 && !nextId) {
          nextId = 1;
          continue;
        }
        break;
      }
      throw err;
    }
  }
}

async function announceNewMemeDiscoveries(newlyDiscoveredNfts: NFT[]) {
  const waves = env.getStringArray('DEPLOYER_ANNOUNCEMENTS_WAVE_IDS');
  if (!waves.length) {
    logger.info(
      'No DEPLOYER_ANNOUNCEMENTS_WAVE_IDS waves found, skipping announcement'
    );
    return;
  }

  const cardPageUrlTemplate =
    env.getStringOrNull('FE_MEMES_CARD_PAGE_URL_TEMPLATE') ??
    'https://6529.io/the-memes/{cardNo}';
  const discoveredMemes = newlyDiscoveredNfts
    .filter((nft) => equalIgnoreCase(nft.contract, MEMES_CONTRACT))
    .sort((a, b) => a.id - b.id);

  for (const meme of discoveredMemes) {
    let memeDescriptor = `Meme #${meme.id}`;
    if (meme.name) {
      memeDescriptor += ` - ${meme.name}`;
    }
    const memeLink = cardPageUrlTemplate.replace(
      '{cardNo}',
      meme.id.toString()
    );
    const message = `🚀 ${memeDescriptor} is Live!\n${memeLink}`;
    try {
      await deployerDropper.drop({ message, waves }, {});
      logger.info(`📣 Posted discovery announcement for meme #${meme.id}`);
    } catch (error: any) {
      logger.error(
        `Failed to post discovery announcement for meme #${meme.id}: ${
          error?.message ?? String(error)
        }`
      );
    }
  }
}

function validateUri(uri: string) {
  if (!isValidUrl(uri)) {
    throw new Error('Invalid URI');
  }
}

function validateMetadata(metadata: any) {
  if (!metadata) {
    throw new Error('Invalid Metadata');
  }
}

function shouldStopDiscovery(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('invalid uri') ||
    lower.includes('invalid token') ||
    lower.includes('nonexistent token')
  );
}

async function buildBaseNft(
  contract: string,
  id: number,
  tokenType: TokenType,
  config: ContractConfig,
  metadata: any,
  EntityClass: typeof NFT | typeof LabNFT
): Promise<NFT | LabNFT> {
  const format = metadata.image_details?.format ?? 'WEBP';
  const tokenPathOriginal = `${contract}/${id}.${format}`;
  const tokenPath = getTokenPath(contract, id, format);
  const { animation, compressedAnimation } = getAnimationPaths(
    contract,
    id,
    metadata.animation_details
  );

  const artist =
    metadata.attributes?.find((a: any) => a.trait_type === 'Artist')?.value ??
    config.artist ??
    '';

  const artistSeizeHandle =
    metadata.attributes?.find(
      (a: any) => a.trait_type?.toUpperCase() === 'SEIZE ARTIST PROFILE'
    )?.value ??
    config.artistSeizeHandle ??
    '';

  const mintPrice = await getMintPrice(contract, id);
  const mintDate = await getMintDate(contract, id);

  const baseNft: any = {
    id,
    contract,
    created_at: new Date(),
    mint_date: mintDate,
    mint_price: mintPrice,
    supply: tokenType === TokenType.ERC721 ? 1 : 0,
    name: metadata.name,
    collection: config.collection,
    token_type: tokenType,
    description: text.replaceEmojisWithHex(metadata.description),
    artist,
    artist_seize_handle: artistSeizeHandle,
    uri: metadata.uri ?? '',
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

  if (EntityClass !== LabNFT) {
    baseNft.hodl_rate = 0;
    baseNft.boosted_tdh = 0;
    baseNft.tdh = 0;
    baseNft.tdh__raw = 0;
    baseNft.tdh_rank = 0;
  }

  return baseNft;
}

type MediaFormat = 'WEBP' | 'GIF' | 'PNG' | 'JPG';
type AnimFormat = 'HTML' | 'MP4' | 'MOV';

type MetaAttr = { trait_type?: string; value?: string | number | boolean };
type MetaObject = {
  image_details?: { format?: MediaFormat };
  animation_details?: { format?: AnimFormat } | string | null;
  attributes?: MetaAttr[];
  name?: string;
  description?: string;
};

type Meta = MetaObject | null | undefined;

function parseAnimationDetails(
  d: MetaObject['animation_details']
): { format?: AnimFormat } | null {
  if (!d) return null;
  if (typeof d === 'string') {
    try {
      return JSON.parse(d) as { format?: AnimFormat };
    } catch {
      return null;
    }
  }
  return d;
}

function findAttr(md: NonNullable<Meta>, name: string): string | undefined {
  const it = (md.attributes ?? []).find(
    (a) => a.trait_type?.toUpperCase() === name.toUpperCase()
  );
  const v = it?.value;

  if (typeof v === 'string') return v;
  if (v != null) return String(v);
  return undefined;
}

function rehydrateFromMetadata(entry: { nft: NFT | LabNFT; changed: boolean }) {
  const { nft } = entry;
  const metadata: Meta = nft.metadata;
  if (!metadata) return;

  // media paths
  const format: MediaFormat = metadata.image_details?.format ?? 'WEBP';
  const tokenPathOriginal = `${nft.contract}/${nft.id}.${format}`;
  const tokenPath = getTokenPath(nft.contract, nft.id, format);

  const anim = parseAnimationDetails(metadata.animation_details);
  const { animation, compressedAnimation } = getAnimationPaths(
    nft.contract,
    nft.id,
    anim
  );

  // artist fields with fallback
  const artist = findAttr(metadata, 'Artist') ?? nft.artist ?? '';
  const artistSeizeHandle =
    findAttr(metadata, 'SEIZE ARTIST PROFILE') ?? nft.artist_seize_handle ?? '';

  // core fields
  nft.name = metadata.name ?? nft.name ?? '';
  nft.description = text.replaceEmojisWithHex(metadata.description ?? '');
  nft.artist = artist;
  nft.artist_seize_handle = artistSeizeHandle;
  nft.icon = `${NFT_SCALED60_IMAGE_LINK}${tokenPath}`;
  nft.thumbnail = `${NFT_SCALED450_IMAGE_LINK}${tokenPath}`;
  nft.scaled = `${NFT_SCALED1000_IMAGE_LINK}${tokenPath}`;
  nft.image = `${NFT_ORIGINAL_IMAGE_LINK}${tokenPathOriginal}`;
  nft.compressed_animation = compressedAnimation ?? undefined;
  nft.animation = animation ?? undefined;

  entry.changed = true;
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
  nftMap: Map<string, { nft: NFT | LabNFT; changed: boolean }>,
  provider: ethers.JsonRpcProvider
) {
  await Promise.all(
    Array.from(nftMap.values()).map(async (entry) => {
      const { nft } = entry;
      const contract = getContractInstance(nft.contract, provider);
      const method = nft.token_type === TokenType.ERC721 ? 'tokenURI' : 'uri';

      try {
        await Promise.all([
          updateUri(entry, contract, method),
          updateMintDate(entry),
          updateMintPrice(entry)
        ]);
      } catch (err: any) {
        logger.warn(
          `⚠️ ${nft.contract} #${nft.id} refresh failed: ${err.message}`
        );
      }
    })
  );
}

async function updateUri(
  entry: { nft: NFT | LabNFT; changed: boolean },
  contract: any,
  method: 'tokenURI' | 'uri'
) {
  const { nft } = entry;
  const uri = await contract[method](nft.id);
  const shouldFetch =
    (uri && uri !== nft.uri && isValidUrl(uri)) || !nft.metadata;
  if (!shouldFetch) return;

  const metadata = await fetchMetadata(uri);
  if (!metadata) return;

  logger.info(
    `♻️ ${nft.contract} #${nft.id} resetting URI from ${
      nft.uri ?? 'undefined'
    } to ${uri}`
  );
  nft.uri = uri;
  nft.metadata = metadata;
  rehydrateFromMetadata(entry);
}

async function updateMintDate(entry: { nft: NFT | LabNFT; changed: boolean }) {
  const { nft } = entry;
  if (nft.mint_date) return;

  logger.info(`🔄 ${nft.contract} #${nft.id} missing mint date, fetching...`);
  const mintDate = await getMintDate(nft.contract, nft.id);
  if (mintDate) {
    logger.info(
      `♻️ ${nft.contract} #${nft.id} updating mint date from ${nft.mint_date} to ${mintDate}`
    );
    nft.mint_date = mintDate;
    entry.changed = true;
  } else {
    logger.warn(`⚠️ ${nft.contract} #${nft.id} mint date not found`);
  }
}

async function updateMintPrice(entry: { nft: NFT | LabNFT; changed: boolean }) {
  const { nft } = entry;
  if (nft.mint_price || equalIgnoreCase(nft.contract, GRADIENT_CONTRACT)) {
    return;
  }

  const mintDate = nft.mint_date
    ? Time.fromDate(new Date(nft.mint_date))
    : null;
  const tooOld =
    mintDate && Time.daysAgo(MINT_DATE_GRACE_PERIOD_DAYS) > mintDate;
  if (tooOld) return; // skip old NFTs

  logger.info(`🔄 ${nft.contract} #${nft.id} missing mint price, fetching...`);
  const mintPrice = await getMintPrice(nft.contract, nft.id);
  if (mintPrice) {
    logger.info(
      `♻️ ${nft.contract} #${nft.id} updating mint price from ${nft.mint_price} to ${mintPrice}`
    );
    nft.mint_price = mintPrice;
    entry.changed = true;
  } else {
    logger.warn(`⚠️ ${nft.contract} #${nft.id} mint price still missing`);
  }
}

async function updateMemeReferences(
  nftMap: Map<string, { nft: any; changed: boolean }>,
  EntityClass: typeof NFT | typeof LabNFT
) {
  if (EntityClass !== LabNFT) return;

  logger.info(`🔄 Updating meme references for ${EntityClass.name}s`);

  const memeNFTs: NFTWithExtendedData[] = await fetchMemesWithSeason();

  Array.from(nftMap.values()).forEach((entry) => {
    const nft = entry.nft as LabNFT;
    const memeRefs = extractMemeRefs(nft.metadata, memeNFTs);
    if (JSON.stringify(memeRefs) !== JSON.stringify(nft.meme_references)) {
      logger.info(
        `♻️ ${nft.contract} #${nft.id} updating meme references from ${nft.meme_references} to ${memeRefs}`
      );
      nft.meme_references = memeRefs;
      entry.changed = true;
    }
  });
}

async function updateSupply(
  nftMap: Map<string, { nft: any; changed: boolean }>,
  updateHodlRate: boolean
) {
  let maxSupply = 0;

  await Promise.all(
    Array.from(nftMap.values()).map(async (entry) => {
      const nft = entry.nft;
      let supply: number;

      if (nft.token_type === TokenType.ERC1155) {
        supply = await getDataSource()
          .getRepository(NFTOwner)
          .createQueryBuilder('owner')
          .select('SUM(owner.balance)', 'sum')
          .where('owner.contract = :contract', { contract: nft.contract })
          .andWhere('owner.token_id = :token_id', { token_id: nft.id })
          .getRawOne()
          .then((res) => Number(res?.sum ?? 0));

        if (equalIgnoreCase(nft.contract, MEMES_CONTRACT) && nft.id === 8) {
          supply += MEME_8_EDITION_BURN_ADJUSTMENT;
        }
      } else {
        supply = Array.from(nftMap.values()).filter((e) =>
          equalIgnoreCase(e.nft.contract, nft.contract)
        ).length;
      }

      if (supply !== nft.supply) {
        logger.info(
          `♻️ ${nft.contract} #${nft.id} updating supply from ${nft.supply} to ${supply}`
        );
        nft.supply = supply;
        entry.changed = true;
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
        logger.info(
          `♻️ ${nft.contract} #${nft.id} updating hodl rate from ${nft.hodl_rate} to ${newRate}`
        );
        nft.hodl_rate = newRate;
        entry.changed = true;
      }
    });
  }
}

async function populateMintStatsForEligibleNFTs(
  nftMap: Map<string, { nft: NFT | LabNFT; changed: boolean }>
) {
  const statsRepo = getDataSource().getRepository(MemesMintStat);
  const txRepo = getDataSource().getRepository(Transaction);

  for (const { nft } of Array.from(nftMap.values())) {
    if (!equalIgnoreCase(nft.contract, MEMES_CONTRACT) || !nft.mint_date) {
      continue;
    }

    if (!isMintStatsEligible(new Date(nft.mint_date))) {
      continue;
    }

    logger.info(`🔄 Populating mint stats for meme #${nft.id}`);
    await populateMintStatsIfMissing(nft.id, nft.mint_date, statsRepo, txRepo);
  }
}

function isMintStatsEligible(mintDate: Date): boolean {
  const mintCloseAt = new Date(
    Date.UTC(
      mintDate.getUTCFullYear(),
      mintDate.getUTCMonth(),
      mintDate.getUTCDate() + 1,
      MEMES_MINT_STATS_CLOSE_HOUR,
      0,
      0,
      0
    )
  );

  return Time.now().gte(Time.fromDate(mintCloseAt));
}

function roundUsd(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

async function populateMintStatsIfMissing(
  tokenId: number,
  mintDate: Date,
  statsRepo: Repository<MemesMintStat>,
  txRepo: Repository<Transaction>
): Promise<void> {
  const existing = await statsRepo.findOne({
    where: { id: tokenId }
  });
  if (existing) {
    logger.info(`ℹ️ Mint stats already exist for meme #${tokenId}, skipping`);
    return;
  }

  const mintTransactions = await txRepo.find({
    select: ['token_count', 'eth_price_usd'],
    where: {
      contract: MEMES_CONTRACT,
      token_id: tokenId,
      from_address: In([NULL_ADDRESS, MANIFOLD]),
      to_address: Not(In([NULL_ADDRESS, MANIFOLD])),
      value: MoreThan(0)
    }
  });

  const redeemedRepo = getDataSource().getRepository(RedeemedSubscription);
  const redeemedAgg = await redeemedRepo
    .createQueryBuilder('rs')
    .leftJoin(
      Transaction,
      't',
      't.transaction = rs.transaction AND t.contract = rs.contract AND t.token_id = rs.token_id AND LOWER(t.to_address) = LOWER(rs.address)'
    )
    .select('COALESCE(SUM(rs.count), 0)', 'redeemedCount')
    .addSelect(
      'COALESCE(SUM(rs.count * :mintPrice * COALESCE(t.eth_price_usd, 0)), 0)',
      'redeemedUsdPrice'
    )
    .where('rs.contract = :contract', { contract: MEMES_CONTRACT })
    .andWhere('rs.token_id = :tokenId', { tokenId })
    .setParameter('mintPrice', MEMES_MINT_PRICE)
    .getRawOne<{
      redeemedCount: string | number;
      redeemedUsdPrice: string | number;
    }>();

  const mintCount = mintTransactions.reduce(
    (sum, tx) => sum + Number(tx.token_count ?? 0),
    0
  );
  const mintedUsdPrice = mintTransactions.reduce(
    (sum, tx) =>
      sum +
      Number(tx.token_count ?? 0) *
        MEMES_MINT_PRICE *
        Number(tx.eth_price_usd ?? 0),
    0
  );
  const redeemedCount = Number(redeemedAgg?.redeemedCount ?? 0);
  const redeemedUsdPrice = Number(redeemedAgg?.redeemedUsdPrice ?? 0);
  const totalMintCount = mintCount + redeemedCount;
  const proceedsEth = totalMintCount * MEMES_MINT_PRICE;
  const proceedsUsd = roundUsd(mintedUsdPrice + redeemedUsdPrice);
  const artistSplitEth = proceedsEth * 0.5;
  const artistSplitUsd = roundUsd(proceedsUsd * 0.5);

  await statsRepo.save({
    id: tokenId,
    mint_date: mintDate,
    mint_count: totalMintCount,
    proceeds_eth: proceedsEth,
    proceeds_usd: proceedsUsd,
    artist_split_eth: artistSplitEth,
    artist_split_usd: artistSplitUsd
  });
  logger.info(
    `✅ Mint stats inserted for meme #${tokenId} [mint_count=${totalMintCount}] [proceeds_eth=${proceedsEth}] [proceeds_usd=${proceedsUsd}] [artist_split_eth=${artistSplitEth}] [artist_split_usd=${artistSplitUsd}]`
  );
}

const getMintPrice = async (contract: string, tokenId: number) => {
  const repo = getDataSource().getRepository(Transaction);
  const firstMintTransaction = await repo.findOne({
    select: ['value'],
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
    select: ['transaction_date'],
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
  if (mode === NFT_MODE.REFRESH) {
    await syncArtists();
  }
}

async function syncArtists() {
  const artists = await fetchAllArtists();
  const allMemesAndGradients = await getDataSource()
    .getRepository(NFT)
    .find({
      select: ['id', 'contract', 'artist']
    });
  const allMemelab = await getDataSource()
    .getRepository(LabNFT)
    .find({
      select: ['id', 'contract', 'artist']
    });
  const allNfts = [...allMemesAndGradients, ...allMemelab];

  logger.info(
    `🔄 Reconciling artists from ${allNfts.length} NFTs (memes/gradients + memelab)`
  );

  const reconciledArtists = await processArtists(artists, allNfts);
  await persistArtists(reconciledArtists);
  await deleteArtistsNotIn(reconciledArtists.map((a) => a.name));

  logger.info(
    `✅ Artists reconciliation complete [current=${reconciledArtists.length}]`
  );
}
