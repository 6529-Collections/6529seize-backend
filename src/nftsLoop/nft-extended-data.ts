import {
  MEME_8_EDITION_BURN_ADJUSTMENT,
  MEMES_CONTRACT,
  NULL_ADDRESS,
  SIX529_MUSEUM
} from '@/constants';
import {
  fetchNftIdsRecordedInTdh,
  fetchAllMemeLabNFTs,
  fetchNftsForContract,
  getDataSource,
  persistLabExtendedData,
  persistMemesExtendedData,
  persistMemesSeasons
} from '../db';
import {
  LabExtendedData,
  LabNFT,
  MemesExtendedData,
  NFT
} from '../entities/INFT';
import { NFTOwner } from '../entities/INFTOwner';
import { MemesSeason } from '../entities/ISeason';
import { ethTools } from '../eth-tools';
import { Logger } from '../logging';
import { getCalculationEditionSize } from '../memes-edition-size-floor';
import { equalIgnoreCase } from '../strings';

const logger = Logger.get('NFT_EXTENDED_DATA');

type ExtendedBase = {
  id: number;
  created_at: Date;
  name?: string;
  collection_size: number;
  edition_size: number;
  edition_size_not_burnt: number;
  edition_size_cleaned: number;
  museum_holdings: number;
  burnt: number;
  museum_holdings_rank: number;
  hodlers: number;
  percent_unique: number;
  percent_unique_not_burnt: number;
  percent_unique_cleaned: number;
  edition_size_rank: number;
  edition_size_not_burnt_rank: number;
  edition_size_cleaned_rank: number;
  hodlers_rank: number;
  percent_unique_rank: number;
  percent_unique_not_burnt_rank: number;
  percent_unique_cleaned_rank: number;
};

interface ExtendedOptions<T, M> {
  nfts: T[];
  getType: () => string;
  getContract: (nft: T) => string;
  getId: (nft: T) => number;
  getName?: (nft: T) => string;
  getMetadata?: (nft: T) => any;
  getExtra?: (nft: T) => Partial<M> | Promise<Partial<M>>;
  rankFilter?: (item: M) => boolean;
  adjustBalances?: (nft: T, owner: NFTOwner) => void;
}

async function generateExtendedData<T, M extends ExtendedBase>(
  opts: ExtendedOptions<T, M>
): Promise<M[]> {
  const {
    nfts,
    getType,
    getContract,
    getId,
    getName,
    getExtra,
    rankFilter,
    adjustBalances
  } = opts;

  logger.info(
    `🛠️ Generating extended data for ${opts.nfts.length} ${getType()} NFTs`
  );

  const results: M[] = [];

  await Promise.all(
    nfts.map(async (nft) => {
      const contract = getContract(nft);
      const id = getId(nft);
      const tokenOwners = await getDataSource()
        .getRepository(NFTOwner)
        .find({
          where: {
            contract,
            token_id: id
          }
        });

      if (adjustBalances) {
        tokenOwners.forEach((o) => adjustBalances(nft, o));
      }

      const nonBurnt = tokenOwners.filter(
        (o) => !ethTools.isNullOrDeadAddress(o.wallet)
      ).length;
      const cleaned = tokenOwners.filter(
        (o) =>
          !ethTools.isNullOrDeadAddress(o.wallet) &&
          !equalIgnoreCase(o.wallet, SIX529_MUSEUM)
      ).length;

      let edition_size = 0;
      let museum_holdings = 0;
      let burnt = 0;
      let edition_size_not_burnt = 0;
      let edition_size_cleaned = 0;

      for (const tw of tokenOwners) {
        if (ethTools.isNullOrDeadAddress(tw.wallet)) {
          burnt += tw.balance;
        } else {
          edition_size_not_burnt += tw.balance;
          if (equalIgnoreCase(tw.wallet, SIX529_MUSEUM)) {
            museum_holdings += tw.balance;
          } else {
            edition_size_cleaned += tw.balance;
          }
        }
        edition_size += tw.balance;
      }

      const percent_unique =
        edition_size > 0 ? tokenOwners.length / edition_size : 0;
      const percent_unique_not_burnt =
        edition_size_not_burnt > 0 ? nonBurnt / edition_size_not_burnt : 0;
      const percent_unique_cleaned =
        edition_size_cleaned > 0 ? cleaned / edition_size_cleaned : 0;

      const base: M = {
        id,
        created_at: new Date(),
        name: getName?.(nft),
        collection_size: nfts.length,
        edition_size,
        edition_size_not_burnt,
        edition_size_cleaned,
        museum_holdings,
        burnt,
        museum_holdings_rank: -1,
        hodlers: tokenOwners.length,
        percent_unique,
        percent_unique_not_burnt,
        percent_unique_cleaned,
        edition_size_rank: -1,
        edition_size_not_burnt_rank: -1,
        edition_size_cleaned_rank: -1,
        hodlers_rank: -1,
        percent_unique_rank: -1,
        percent_unique_not_burnt_rank: -1,
        percent_unique_cleaned_rank: -1
      } as M;

      const extra = await getExtra?.(nft);
      if (extra) {
        Object.assign(base, extra);
      }

      results.push(base);
    })
  );

  const rankedResults = rankFilter ? results.filter(rankFilter) : results;

  // Ascending: smaller is better
  assignRanks(rankedResults, 'edition_size', 'asc');
  assignRanks(rankedResults, 'museum_holdings', 'asc');
  assignRanks(rankedResults, 'edition_size_not_burnt', 'asc');
  assignRanks(rankedResults, 'edition_size_cleaned', 'asc');

  // Descending: bigger is better
  assignRanks(rankedResults, 'hodlers', 'desc');
  assignRanks(rankedResults, 'percent_unique', 'desc');
  assignRanks(rankedResults, 'percent_unique_not_burnt', 'desc');
  assignRanks(rankedResults, 'percent_unique_cleaned', 'desc');

  return results;
}

function assignRanks<T extends { id: number }>(
  arr: T[],
  field: keyof T & string,
  direction: 'asc' | 'desc' = 'desc'
) {
  assignRanksByValue(
    arr,
    `${field}_rank`,
    (item) => (item as any)[field],
    direction
  );
}

export function assignRanksByValue<T extends { id: number }>(
  arr: T[],
  rankField: string,
  valueGetter: (item: T) => number,
  direction: 'asc' | 'desc' = 'desc'
) {
  // rank = 1 + number of strictly-better items, where "better" is
  // (value per direction, then lower id). (value, id) is a total order, so
  // sorting by it and assigning positions yields the same ranks as counting.
  const sorted = [...arr].sort((a, b) => {
    const aValue = valueGetter(a);
    const bValue = valueGetter(b);
    if (aValue !== bValue) {
      return direction === 'asc' ? aValue - bValue : bValue - aValue;
    }
    return a.id - b.id;
  });
  sorted.forEach((item, index) => {
    (item as any)[rankField] = index + 1;
  });
}

export async function findMemesExtendedData() {
  const nfts = await fetchNftsForContract(MEMES_CONTRACT, 'id desc');
  const recordedTdhIds = await fetchRecordedTdhIdsForRanks(
    MEMES_CONTRACT,
    nfts.map((nft) => nft.id)
  );

  const extended = await generateExtendedData<NFT, MemesExtendedData>({
    nfts,
    getType: () => 'The Memes',
    getContract: (nft) => nft.contract,
    getId: (nft) => nft.id,
    getName: (nft) =>
      nft.metadata?.attributes?.find((a: any) => a.trait_type === 'Meme Name')
        ?.value,
    adjustBalances: (nft, owner) => {
      if (nft.id === 8 && equalIgnoreCase(owner.wallet, NULL_ADDRESS)) {
        owner.balance += MEME_8_EDITION_BURN_ADJUSTMENT;
      }
    },
    getExtra: async (nft) => {
      const attrs = nft.metadata?.attributes ?? [];
      return {
        season: Number.parseInt(
          attrs.find((a: any) => a.trait_type === 'Type - Season')?.value ??
            '0',
          10
        ),
        meme: Number.parseInt(
          attrs.find((a: any) => a.trait_type === 'Type - Meme')?.value ?? '0',
          10
        ),
        meme_name: attrs.find((a: any) => a.trait_type === 'Meme Name')?.value,
        recorded_in_tdh: recordedTdhIds ? recordedTdhIds.has(nft.id) : null
      };
    },
    rankFilter: recordedTdhIds ? isMemeRecordedInTdh : undefined
  });
  assignEditionSizeFloorRanks(extended, nfts, recordedTdhIds);
  assignRankedCollectionSize(extended, recordedTdhIds);

  // Seasons
  const seasons = Array.from(new Set(extended.map((e) => e.season)));
  const memesSeasons: MemesSeason[] = seasons.map((s) => {
    const inSeason = extended.filter((e) => e.season === s);
    let boost = 0;
    if (s <= 20) {
      boost = 0.05;
    }
    const memesSeason: MemesSeason = {
      id: s,
      created_at: new Date(),
      start_index: Math.min(...inSeason.map((m) => m.id)),
      end_index: Math.max(...inSeason.map((m) => m.id)),
      count: inSeason.length,
      name: `Season ${s}`,
      display: `SZN${s}`,
      boost
    };
    return memesSeason;
  });

  await persistMemesExtendedData(extended);
  await persistMemesSeasons(memesSeasons);
  return extended;
}

function assignEditionSizeFloorRanks(
  extended: MemesExtendedData[],
  nfts: NFT[],
  recordedTdhIds: Set<number> | null
) {
  const nftById = new Map(nfts.map((nft) => [nft.id, nft]));
  const rankedMemes = recordedTdhIds
    ? extended.filter(isMemeRecordedInTdh)
    : extended;

  assignRanksByValue(
    rankedMemes,
    'edition_size_rank',
    (meme) =>
      getCalculationEditionSize({
        supply: meme.edition_size,
        edition_size_floor: nftById.get(meme.id)?.edition_size_floor
      }),
    'asc'
  );
}

async function fetchRecordedTdhIdsForRanks(
  contract: string,
  ids: readonly number[]
) {
  try {
    const recordedIds = await fetchNftIdsRecordedInTdh(contract, ids);
    if (recordedIds.size > 0) {
      return recordedIds;
    }
    logger.warn(
      `No TDH NFT rows found for contract ${contract}; keeping legacy Meme rank behavior for this run`
    );
  } catch (error) {
    logger.error(
      `Failed to fetch TDH NFT rows for contract ${contract}; keeping legacy Meme rank behavior for this run`,
      error
    );
  }
  return null;
}

function isMemeRecordedInTdh(meme: MemesExtendedData) {
  return meme.recorded_in_tdh === true;
}

function assignRankedCollectionSize(
  extended: MemesExtendedData[],
  recordedTdhIds: Set<number> | null
) {
  if (!recordedTdhIds) {
    extended.forEach((meme) => (meme.ranked_collection_size = null));
    return;
  }

  const rankedCollectionSize = extended.filter(isMemeRecordedInTdh).length;
  extended.forEach((meme) => {
    meme.ranked_collection_size = isMemeRecordedInTdh(meme)
      ? rankedCollectionSize
      : null;
  });
}

export async function findMemeLabExtendedData() {
  const nfts = await fetchAllMemeLabNFTs();

  const extended = await generateExtendedData<LabNFT, LabExtendedData>({
    nfts,
    getType: () => 'MemeLab',
    getContract: (nft) => nft.contract,
    getId: (nft) => nft.id,
    getName: (nft) => nft.name!,
    getExtra: (nft) => {
      const attrs = nft.metadata?.attributes ?? [];
      return {
        meme_references: nft.meme_references,
        metadata_collection: attrs.find(
          (a: any) => a.trait_type?.toUpperCase() === 'COLLECTION'
        )?.value,
        website: (() => {
          const trait = attrs.find(
            (a: any) => a.trait_type?.toUpperCase() === 'WEBSITE'
          );
          return trait && trait.value !== 'None' ? trait.value : undefined;
        })()
      };
    }
  });

  await persistLabExtendedData(extended);
  return extended;
}
