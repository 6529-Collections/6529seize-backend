import { MEMES_CONTRACT, SIX529_MUSEUM } from './constants';
import { MemesExtendedData, NFT } from './entities/INFT';
import { Owner } from './entities/IOwner';
import { areEqualAddresses, isNullAddress } from './helpers';
import {
  fetchAllOwners,
  fetchNftsForContract,
  persistMemesExtendedData
} from './db';
import { Logger } from './logging';

const logger = Logger.get('MEMES_EXTENDED_DATA');

export const findMemesExtendedData = async () => {
  let nfts: NFT[] = await fetchNftsForContract(MEMES_CONTRACT, 'id desc');
  const owners: Owner[] = await fetchAllOwners();

  nfts = [...nfts].filter((t) => areEqualAddresses(t.contract, MEMES_CONTRACT));

  logger.info(`[NFTS ${nfts.length}]`);

  const memesMeta: MemesExtendedData[] = [];

  nfts.forEach((nft) => {
    const allTokenWallets = [...owners].filter(
      (o) =>
        o.token_id == nft.id && areEqualAddresses(o.contract, MEMES_CONTRACT)
    );

    const nonBurntTokenWallets = [...allTokenWallets].filter(
      (o) => !isNullAddress(o.wallet)
    ).length;

    const cleanedTokenWallets = [...allTokenWallets].filter(
      (o) =>
        !isNullAddress(o.wallet) && !areEqualAddresses(o.wallet, SIX529_MUSEUM)
    ).length;

    let edition_size = 0;
    let museum_holdings = 0;
    let burnt = 0;
    let edition_size_not_burnt = 0;
    let edition_size_cleaned = 0;
    allTokenWallets.forEach((tw) => {
      if (isNullAddress(tw.wallet)) {
        burnt += tw.balance;
      } else {
        edition_size_not_burnt += tw.balance;
        if (!areEqualAddresses(tw.wallet, SIX529_MUSEUM)) {
          edition_size_cleaned += tw.balance;
        } else {
          museum_holdings += tw.balance;
        }
      }

      edition_size += tw.balance;
    });

    const season = parseInt(
      nft.metadata!.attributes?.find(
        (a: any) => a.trait_type === 'Type - Season'
      )?.value
    );
    const meme = parseInt(
      nft.metadata.attributes.find((a: any) => a.trait_type === 'Type - Meme')
        ?.value
    );
    const meme_name = nft.metadata.attributes.find(
      (a: any) => a.trait_type === 'Meme Name'
    )?.value;
    const meta: MemesExtendedData = {
      id: nft.id,
      created_at: new Date(),
      season: season,
      meme: meme,
      meme_name: meme_name,
      collection_size: nfts.length,
      edition_size: edition_size,
      edition_size_not_burnt: edition_size_not_burnt,
      edition_size_cleaned: edition_size_cleaned,
      museum_holdings: museum_holdings,
      burnt: burnt,
      museum_holdings_rank: -1,
      hodlers: allTokenWallets.length,
      percent_unique: allTokenWallets.length / edition_size,
      percent_unique_not_burnt: nonBurntTokenWallets / edition_size_not_burnt,
      percent_unique_cleaned: cleanedTokenWallets / edition_size_cleaned,
      edition_size_rank: -1,
      edition_size_not_burnt_rank: -1,
      edition_size_cleaned_rank: -1,
      hodlers_rank: -1,
      percent_unique_rank: -1,
      percent_unique_not_burnt_rank: -1,
      percent_unique_cleaned_rank: -1
    };
    memesMeta.push(meta);
  });

  memesMeta.forEach((mm) => {
    mm.edition_size_rank =
      memesMeta.filter((m) => {
        if (mm.edition_size > m.edition_size) {
          return m;
        }
        if (m.edition_size == mm.edition_size) {
          if (mm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
    mm.edition_size_not_burnt_rank =
      memesMeta.filter((m) => {
        if (mm.edition_size_not_burnt > m.edition_size_not_burnt) {
          return m;
        }
        if (m.edition_size_not_burnt == mm.edition_size_not_burnt) {
          if (mm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
    mm.museum_holdings_rank =
      memesMeta.filter((m) => {
        if (mm.museum_holdings > m.museum_holdings) {
          return m;
        }
        if (m.museum_holdings == mm.museum_holdings) {
          if (mm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
    mm.edition_size_cleaned_rank =
      memesMeta.filter((m) => {
        if (mm.edition_size_cleaned > m.edition_size_cleaned) {
          return m;
        }
        if (m.edition_size_cleaned == mm.edition_size_cleaned) {
          if (mm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
    mm.hodlers_rank =
      memesMeta.filter((m) => {
        if (m.hodlers > mm.hodlers) {
          return m;
        }
        if (m.hodlers == mm.hodlers) {
          if (mm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
    mm.percent_unique_rank =
      memesMeta.filter((m) => {
        if (m.percent_unique > mm.percent_unique) {
          return m;
        }
        if (m.percent_unique == mm.percent_unique) {
          if (mm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
    mm.percent_unique_not_burnt_rank =
      memesMeta.filter((m) => {
        if (m.percent_unique_not_burnt > mm.percent_unique_not_burnt) {
          return m;
        }
        if (m.percent_unique_not_burnt == mm.percent_unique_not_burnt) {
          if (mm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
    mm.percent_unique_cleaned_rank =
      memesMeta.filter((m) => {
        if (m.percent_unique_cleaned > mm.percent_unique_cleaned) {
          return m;
        }
        if (m.percent_unique_cleaned == mm.percent_unique_cleaned) {
          if (mm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
  });

  await persistMemesExtendedData(memesMeta);

  return memesMeta;
};
