import {
  MEME_8_EDITION_BURN_ADJUSTMENT,
  MEMES_CONTRACT,
  NULL_ADDRESS,
  SIX529_MUSEUM
} from '@/constants';
import {
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
  getExtra?: (nft: T) => Partial<M>;
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
          if (!equalIgnoreCase(tw.wallet, SIX529_MUSEUM)) {
            edition_size_cleaned += tw.balance;
          } else {
            museum_holdings += tw.balance;
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
        percent_unique_cleaned_rank: -1,
        ...getExtra?.(nft)
      } as M;

      results.push(base);
    })
  );

  // Ascending: smaller is better
  assignRanks(results, 'edition_size', 'asc');
  assignRanks(results, 'museum_holdings', 'asc');
  assignRanks(results, 'edition_size_not_burnt', 'asc');
  assignRanks(results, 'edition_size_cleaned', 'asc');

  // Descending: bigger is better
  assignRanks(results, 'hodlers', 'desc');
  assignRanks(results, 'percent_unique', 'desc');
  assignRanks(results, 'percent_unique_not_burnt', 'desc');
  assignRanks(results, 'percent_unique_cleaned', 'desc');

  return results;
}

function assignRanks<T extends { id: number }>(
  arr: T[],
  field: keyof T & string,
  direction: 'asc' | 'desc' = 'desc'
) {
  arr.forEach((item) => {
    const rank =
      arr.filter((other) => {
        const a = (item as any)[field];
        const b = (other as any)[field];

        if (direction === 'asc') {
          return b < a || (b === a && other.id < item.id);
        } else {
          return b > a || (b === a && other.id < item.id);
        }
      }).length + 1;

    (item as any)[`${field}_rank`] = rank;
  });
}

export async function findMemesExtendedData() {
  const nfts = await fetchNftsForContract(MEMES_CONTRACT, 'id desc');

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
    getExtra: (nft) => {
      const attrs = nft.metadata?.attributes ?? [];
      return {
        season: parseInt(
          attrs.find((a: any) => a.trait_type === 'Type - Season')?.value ?? '0'
        ),
        meme: parseInt(
          attrs.find((a: any) => a.trait_type === 'Type - Meme')?.value ?? '0'
        ),
        meme_name: attrs.find((a: any) => a.trait_type === 'Meme Name')?.value
      };
    }
  });

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
