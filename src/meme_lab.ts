import { Alchemy, Nft, Utils } from 'alchemy-sdk';
import {
  ALCHEMY_SETTINGS,
  MANIFOLD,
  MEMELAB_CONTRACT,
  NFT_HTML_LINK,
  NFT_ORIGINAL_IMAGE_LINK,
  NFT_SCALED1000_IMAGE_LINK,
  NFT_SCALED450_IMAGE_LINK,
  NFT_SCALED60_IMAGE_LINK,
  NFT_VIDEO_LINK,
  NULL_ADDRESS,
  SIX529_MUSEUM
} from './constants';
import { LabExtendedData, LabNFT, NFTWithExtendedData } from './entities/INFT';
import { Transaction } from './entities/ITransaction';
import {
  areEqualAddresses,
  areEqualObjects,
  isNullAddress,
  replaceEmojisWithHex
} from './helpers';
import {
  fetchAllArtists,
  fetchAllMemeLabNFTs,
  fetchAllMemeLabTransactions,
  fetchMemesWithSeason,
  persistArtists,
  persistLabExtendedData,
  persistLabNFTRoyalties,
  persistLabNFTS
} from './db';
import { Artist } from './entities/IArtist';
import { processArtists } from './artists';

import { RequestInfo, RequestInit } from 'node-fetch';
import { Logger } from './logging';
import { getNFTResponse } from './nftsLoop/nfts';
import { NFTOwner } from './entities/INFTOwner';
import { fetchAllNftOwners } from './nftOwnersLoop/db.nft_owners';

const logger = Logger.get('MEME_LAB');

const fetch = (url: RequestInfo, init?: RequestInit) =>
  import('node-fetch').then(({ default: fetch }) => fetch(url, init));

let alchemy: Alchemy;

async function getAllNFTs(nfts: Nft[] = [], key = ''): Promise<Nft[]> {
  const response = await getNFTResponse(alchemy, MEMELAB_CONTRACT, key);
  const newKey = response.pageKey;
  nfts = nfts.concat(response.nfts);

  if (newKey) {
    return getAllNFTs(nfts, newKey);
  }

  return nfts;
}

async function processNFTs(
  startingNFTS: LabNFT[],
  startingTransactions: Transaction[],
  owners: NFTOwner[]
) {
  const allNFTS = await getAllNFTs();

  logger.info(
    `[NFTS] [DB ${startingNFTS.length}] [CONTRACT ${allNFTS.length}]`
  );

  const newNFTS: LabNFT[] = [];
  await Promise.all(
    allNFTS.map(async (mnft) => {
      const tokenId = parseInt(mnft.tokenId);

      const tokenWallets = owners.filter(
        (tw) =>
          !areEqualAddresses(NULL_ADDRESS, tw.wallet) && tw.token_id == tokenId
      );

      const startingNft = startingNFTS.find(
        (s) =>
          s.id == tokenId && areEqualAddresses(s.contract, MEMELAB_CONTRACT)
      );

      const fullMetadata = await (await fetch(mnft.raw.tokenUri!)).json();

      const tokenTransactions = [...startingTransactions]
        .filter((t) => t.token_id == tokenId)
        .sort((a, b) => (a.transaction_date > b.transaction_date ? 1 : -1));

      const createdTransactions = [...tokenTransactions].filter((t) =>
        areEqualAddresses(NULL_ADDRESS, t.from_address)
      );

      const firstMintNull = tokenTransactions.find(
        (t) => areEqualAddresses(NULL_ADDRESS, t.from_address) && t.value > 0
      );

      let editionSize = 0;
      tokenWallets.forEach((tw) => {
        editionSize += tw.balance;
      });

      let mintPrice = 0;
      if (firstMintNull) {
        const mintTransaction = await alchemy.core.getTransaction(
          firstMintNull?.transaction
        );
        mintPrice = mintTransaction
          ? parseFloat(Utils.formatEther(mintTransaction.value))
          : 0;
        if (mintPrice) {
          mintPrice = mintPrice / firstMintNull.token_count;
        }
      } else {
        const firstMintManifold = tokenTransactions.find(
          (t) => areEqualAddresses(MANIFOLD, t.from_address) && t.value > 0
        );
        if (firstMintManifold) {
          const mintTransaction = await alchemy.core.getTransaction(
            firstMintManifold?.transaction
          );
          mintPrice = mintTransaction
            ? parseFloat(Utils.formatEther(mintTransaction.value))
            : 0;
          if (mintPrice) {
            mintPrice = mintPrice / firstMintManifold.token_count;
          }
        }
      }

      const format = fullMetadata.image_details.format;
      let tokenPath;
      if (format.toUpperCase() == 'GIF') {
        tokenPath = `${MEMELAB_CONTRACT}/${tokenId}.${format}`;
      } else {
        tokenPath = `${MEMELAB_CONTRACT}/${tokenId}.WEBP`;
      }
      const tokenPathOriginal = `${MEMELAB_CONTRACT}/${tokenId}.${format}`;

      let animation = fullMetadata.animation
        ? fullMetadata.animation
        : fullMetadata.animation_url;
      const animationDetails = fullMetadata.animation_details;

      let compressedAnimation;

      if (animationDetails) {
        if (animationDetails.format == 'MP4') {
          animation = `${NFT_VIDEO_LINK}${MEMELAB_CONTRACT}/${tokenId}.${animationDetails.format}`;
          compressedAnimation = `${NFT_VIDEO_LINK}${MEMELAB_CONTRACT}/scaledx750/${tokenId}.${animationDetails.format}`;
        }
        if (animationDetails.format == 'HTML') {
          animation = `${NFT_HTML_LINK}${MEMELAB_CONTRACT}/${tokenId}.${animationDetails.format}`;
        }
      }

      const artists: string[] = [];
      fullMetadata.attributes?.map((a: any) => {
        if (
          a.trait_type.toUpperCase().startsWith('ARTIST') &&
          a.value &&
          a.value.toUpperCase() != 'NONE'
        ) {
          artists.push(a.value);
        }
      });

      const artistSeizeProfile = fullMetadata.attributes?.find(
        (a: any) => a.trait_type.toUpperCase() === 'SEIZE ARTIST PROFILE'
      )?.value;

      const memeReferences: number[] = [];
      const memeNFTs: NFTWithExtendedData[] = await fetchMemesWithSeason();

      fullMetadata.attributes?.map((a: any) => {
        if (
          a.trait_type.toUpperCase().startsWith('MEME CARD REFERENCE') &&
          a.value &&
          a.value.toUpperCase() != 'NONE'
        ) {
          const ref = a.value;
          if (ref.toUpperCase() == 'ALL') {
            memeReferences.push(...[...memeNFTs].map((m) => m.id));
          } else if (ref.toUpperCase() == 'ALL SZN1') {
            memeReferences.push(
              ...[...memeNFTs].filter((m) => m.season == 1).map((m) => m.id)
            );
          } else if (ref.toUpperCase() == 'ALL SZN2') {
            memeReferences.push(
              ...[...memeNFTs].filter((m) => m.season == 2).map((m) => m.id)
            );
          } else if (ref.toUpperCase() == 'ALL SZN3') {
            memeReferences.push(
              ...[...memeNFTs].filter((m) => m.season == 3).map((m) => m.id)
            );
          } else if (ref.toUpperCase() == 'ALL SZN4') {
            memeReferences.push(
              ...[...memeNFTs].filter((m) => m.season == 4).map((m) => m.id)
            );
          } else if (ref.toUpperCase() == 'ALL SZN5') {
            memeReferences.push(
              ...[...memeNFTs].filter((m) => m.season == 5).map((m) => m.id)
            );
          } else if (ref.toUpperCase() == 'ALL SZN6') {
            memeReferences.push(
              ...[...memeNFTs].filter((m) => m.season == 6).map((m) => m.id)
            );
          } else {
            const memeRef = memeNFTs.find((m) => m.name == ref);
            if (memeRef) {
              memeReferences.push(memeRef.id);
            }
          }
        }
      });

      const nft: LabNFT = {
        id: tokenId,
        contract: MEMELAB_CONTRACT,
        created_at: new Date(),
        mint_date: createdTransactions[0]
          ? new Date(createdTransactions[0].transaction_date)
          : new Date(),
        mint_price: mintPrice,
        supply: editionSize,
        name: fullMetadata.name,
        collection: 'Meme Lab by 6529',
        token_type: 'ERC1155',
        description: replaceEmojisWithHex(fullMetadata.description),
        artist: artists.join(', '),
        artist_seize_handle: artistSeizeProfile ?? '',
        uri: fullMetadata.tokenUri?.raw,
        icon: `${NFT_SCALED60_IMAGE_LINK}${tokenPath}`,
        thumbnail: `${NFT_SCALED450_IMAGE_LINK}${tokenPath}`,
        scaled: `${NFT_SCALED1000_IMAGE_LINK}${tokenPath}`,
        image: `${NFT_ORIGINAL_IMAGE_LINK}${tokenPathOriginal}`,
        compressed_animation: compressedAnimation,
        animation: animation,
        metadata: fullMetadata,
        meme_references: memeReferences,
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

  logger.info(`[NFTS] [PROCESSED ${newNFTS.length} NEW NFTS]`);
  return newNFTS;
}

export const findNFTs = async (
  startingNFTS: LabNFT[],
  startingTransactions: Transaction[],
  owners: NFTOwner[],
  reset?: boolean
) => {
  const allNFTs = await processNFTs(startingNFTS, startingTransactions, owners);

  const delta: LabNFT[] = [];
  allNFTs.forEach((n) => {
    const m = startingNFTS.find(
      (s) => areEqualAddresses(s.contract, n.contract) && s.id == n.id
    );
    let changed = false;
    if (!m) {
      changed = true;
    } else if (
      new Date(n.mint_date).getTime() != new Date(m.mint_date).getTime()
    ) {
      changed = true;
    } else if (n.supply == 0) {
      changed = true;
    } else {
      const nClone: any = { ...n };
      const mClone: any = { ...m };
      delete nClone.floor_price;
      delete nClone.market_cap;
      delete nClone.created_at;
      delete nClone.mint_date;
      delete mClone.floor_price;
      delete mClone.market_cap;
      delete mClone.created_at;

      if (!areEqualObjects(nClone, mClone)) {
        changed = true;
      }
    }
    if (changed || reset) {
      n.floor_price = m ? m.floor_price : n.floor_price;
      n.market_cap = m ? m.market_cap : n.market_cap;
      delta.push(n);
    }
  });

  logger.info(`[NFTS] [CHANGED ${delta.length}] [RESET ${reset}]`);

  return delta;
};

export async function memeLabNfts(reset?: boolean) {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const nfts: LabNFT[] = await fetchAllMemeLabNFTs();
  const transactions: Transaction[] = await fetchAllMemeLabTransactions();
  const owners: NFTOwner[] = await fetchAllNftOwners([MEMELAB_CONTRACT]);
  const artists: Artist[] = await fetchAllArtists();

  const newNfts = await findNFTs(nfts, transactions, owners, reset);
  const newArtists = await processArtists(artists, newNfts);
  await persistLabNFTS(newNfts);
  await persistLabNFTRoyalties();
  await persistArtists(newArtists);
}

export async function memeLabExtendedData() {
  const nfts: LabNFT[] = await fetchAllMemeLabNFTs();
  const owners: NFTOwner[] = await fetchAllNftOwners([MEMELAB_CONTRACT]);

  logger.info(`[MEMES EXTENDED DATA] [NFTS ${nfts.length}]`);

  const labMeta: LabExtendedData[] = [];

  nfts.forEach((nft) => {
    const tokenWallets = owners.filter((tw) => tw.token_id == nft.id);

    const nonBurntTokenWallets = [...tokenWallets].filter(
      (o) => !isNullAddress(o.wallet)
    ).length;

    let edition_size = 0;
    let museum_holdings = 0;
    let burnt = 0;
    let edition_size_not_burnt = 0;
    let edition_size_cleaned = 0;
    tokenWallets.forEach((tw) => {
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

    let metaCollection = '';
    const metaCollectionTrait = nft.metadata.attributes.find(
      (a: any) => a.trait_type.toUpperCase() == 'COLLECTION'
    );
    if (metaCollectionTrait) {
      metaCollection = metaCollectionTrait.value;
    }

    let website;
    const metaWebsiteTrait = nft.metadata.attributes.find(
      (a: any) => a.trait_type.toUpperCase() == 'WEBSITE'
    );
    if (metaWebsiteTrait && metaWebsiteTrait.value != 'None') {
      website = metaWebsiteTrait.value;
    }

    const meta: LabExtendedData = {
      id: nft.id,
      created_at: new Date(),
      name: nft.name!,
      metadata_collection: metaCollection,
      meme_references: nft.meme_references,
      collection_size: nfts.length,
      edition_size: edition_size,
      edition_size_cleaned: edition_size_cleaned,
      museum_holdings: museum_holdings,
      museum_holdings_rank: -1,
      hodlers: tokenWallets.length,
      percent_unique: tokenWallets.length / edition_size,
      percent_unique_cleaned: tokenWallets.length / edition_size_cleaned,
      edition_size_rank: -1,
      edition_size_cleaned_rank: -1,
      hodlers_rank: -1,
      percent_unique_rank: -1,
      percent_unique_cleaned_rank: -1,
      website: website,
      burnt: burnt,
      edition_size_not_burnt: edition_size_not_burnt,
      edition_size_not_burnt_rank: -1,
      percent_unique_not_burnt: nonBurntTokenWallets / edition_size_not_burnt,
      percent_unique_not_burnt_rank: -1
    };
    labMeta.push(meta);
  });

  labMeta.forEach((lm) => {
    lm.edition_size_rank =
      labMeta.filter((m) => {
        if (lm.edition_size > m.edition_size) {
          return m;
        }
        if (m.edition_size == lm.edition_size) {
          if (lm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
    lm.museum_holdings_rank =
      labMeta.filter((m) => {
        if (lm.museum_holdings > m.museum_holdings) {
          return m;
        }
        if (m.museum_holdings == lm.museum_holdings) {
          if (lm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
    lm.edition_size_not_burnt_rank =
      labMeta.filter((m) => {
        if (lm.edition_size_not_burnt > m.edition_size_not_burnt) {
          return m;
        }
        if (m.edition_size_not_burnt == lm.edition_size_not_burnt) {
          if (lm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
    lm.edition_size_cleaned_rank =
      labMeta.filter((m) => {
        if (lm.edition_size_cleaned > m.edition_size_cleaned) {
          return m;
        }
        if (m.edition_size_cleaned == lm.edition_size_cleaned) {
          if (lm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
    lm.hodlers_rank =
      labMeta.filter((m) => {
        if (m.hodlers > lm.hodlers) {
          return m;
        }
        if (m.hodlers == lm.hodlers) {
          if (lm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
    lm.percent_unique_cleaned_rank =
      labMeta.filter((m) => {
        if (m.percent_unique_cleaned > lm.percent_unique_cleaned) {
          return m;
        }
        if (m.percent_unique_cleaned == lm.percent_unique_cleaned) {
          if (lm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
    lm.percent_unique_rank =
      labMeta.filter((m) => {
        if (m.percent_unique > lm.percent_unique) {
          return m;
        }
        if (m.percent_unique == lm.percent_unique) {
          if (lm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
    lm.percent_unique_not_burnt_rank =
      labMeta.filter((m) => {
        if (m.percent_unique_not_burnt > lm.percent_unique_not_burnt) {
          return m;
        }
        if (m.percent_unique_not_burnt == lm.percent_unique_not_burnt) {
          if (lm.id > m.id) {
            return m;
          }
        }
      }).length + 1;
  });

  await persistLabExtendedData(labMeta);

  return labMeta;
}
