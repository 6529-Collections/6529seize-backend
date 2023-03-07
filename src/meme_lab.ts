import { findTransactions } from './transactions';
import { getAllOwners, ownersMatch } from './owners';
import { findTransactionValues } from './transaction_values';
import { discoverEns } from './ens';
import { Alchemy, fromHex, Nft, Utils } from 'alchemy-sdk';
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
import { LabTransaction } from './entities/ITransaction';
import { areEqualAddresses, areEqualObjects } from './helpers';
import {
  fetchAllMemeLabNFTs,
  persistTransactions,
  fetchLatestLabTransactionsBlockNumber,
  fetchAllMemeLabTransactions,
  persistLabNFTS,
  fetchAllArtists,
  persistArtists,
  fetchAllLabOwners,
  persistOwners,
  fetchMemesWithSeason,
  persistLabExtendedData,
  persistDistributionMinting
} from './db';
import { Artist } from './entities/IArtist';
import { findArtists } from './artists';
import { Owner } from './entities/IOwner';

let alchemy: Alchemy;

async function getNFTResponse(contract: string, key: any) {
  const settings = {
    pageKey: undefined
  };

  if (key) {
    settings.pageKey = key;
  }

  const response = await alchemy.nft.getNftsForContract(contract, settings);
  return response;
}

async function getAllNFTs(nfts: Nft[] = [], key: string = ''): Promise<Nft[]> {
  const response = await getNFTResponse(MEMELAB_CONTRACT, key);
  const newKey = response.pageKey;
  nfts = nfts.concat(response.nfts);

  if (newKey) {
    return getAllNFTs(nfts, newKey);
  }

  return nfts;
}

async function processNFTs(
  startingNFTS: LabNFT[],
  startingTransactions: LabTransaction[],
  owners: Owner[]
) {
  const allNFTS = await getAllNFTs();

  console.log(
    '[NFTS]',
    `[DB ${startingNFTS.length}][CONTRACT ${allNFTS.length}]`
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

      const fullMetadata = await alchemy.nft.getNftMetadata(
        MEMELAB_CONTRACT,
        tokenId
      );

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
      tokenWallets.map((tw) => {
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

      const tokenContract = fullMetadata.contract;

      const format = fullMetadata.rawMetadata?.image_details.format;
      let tokenPath;
      if (format.toUpperCase() == 'GIF') {
        tokenPath = `${MEMELAB_CONTRACT}/${tokenId}.${format}`;
      } else {
        tokenPath = `${MEMELAB_CONTRACT}/${tokenId}.WEBP`;
      }
      const tokenPathOriginal = `${MEMELAB_CONTRACT}/${tokenId}.${format}`;

      let animation = fullMetadata.rawMetadata?.animation;
      const animationDetails = fullMetadata.rawMetadata?.animation_details;

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
      fullMetadata.rawMetadata?.attributes?.map((a) => {
        if (
          a.trait_type.toUpperCase().startsWith('ARTIST') &&
          a.value &&
          a.value.toUpperCase() != 'NONE'
        ) {
          artists.push(a.value);
        }
      });

      const memeReferences: number[] = [];
      const memeNFTs: NFTWithExtendedData[] = await fetchMemesWithSeason();

      fullMetadata.rawMetadata?.attributes?.map((a) => {
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
        name: fullMetadata.rawMetadata?.name,
        collection: 'Meme Lab by 6529',
        token_type: tokenContract.tokenType,
        description: fullMetadata.description,
        artist: artists.join(', '),
        uri: fullMetadata.tokenUri?.raw,
        icon: `${NFT_SCALED60_IMAGE_LINK}${tokenPath}`,
        thumbnail: `${NFT_SCALED450_IMAGE_LINK}${tokenPath}`,
        scaled: `${NFT_SCALED1000_IMAGE_LINK}${tokenPath}`,
        image: `${NFT_ORIGINAL_IMAGE_LINK}${tokenPathOriginal}`,
        compressed_animation: compressedAnimation,
        animation: animation,
        metadata: fullMetadata.rawMetadata,
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
  console.log(`[NFTS]`, `[PROCESSED ${newNFTS.length} NEW NFTS]`);
  return newNFTS;
}

export const findNFTs = async (
  startingNFTS: LabNFT[],
  startingTransactions: LabTransaction[],
  owners: Owner[],
  reset?: boolean
) => {
  const allNFTs = await processNFTs(startingNFTS, startingTransactions, owners);

  const delta: LabNFT[] = [];
  allNFTs.map((n) => {
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

  console.log(`[NFTS]`, `[CHANGED ${delta.length}]`, `[RESET ${reset}]`);

  return delta;
};

export async function memeLabNfts(reset?: boolean) {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const nfts: LabNFT[] = await fetchAllMemeLabNFTs();
  const transactions: LabTransaction[] = await fetchAllMemeLabTransactions();
  let owners: Owner[] = await fetchAllLabOwners();
  const artists: Artist[] = await fetchAllArtists();

  const newNfts = await findNFTs(nfts, transactions, owners, reset);
  const newArtists = await findArtists(artists, newNfts);
  await persistLabNFTS(newNfts);
  await persistArtists(newArtists);
}

export async function memeLabTransactions() {
  const now = new Date();
  await transactions();
  await discoverEns(now);
}

async function transactions(
  startingBlock?: number,
  latestBlock?: number,
  pagKey?: string
) {
  try {
    let startingBlockResolved: number;
    if (startingBlock == undefined) {
      startingBlockResolved = await fetchLatestLabTransactionsBlockNumber();
    } else {
      startingBlockResolved = startingBlock;
    }

    const response = await findTransactions(
      startingBlockResolved,
      latestBlock,
      pagKey,
      [MEMELAB_CONTRACT]
    );

    const transactionsWithValues = await findTransactionValues(
      response.transactions
    );

    const newtransactionsWithValues = transactionsWithValues.filter(
      (tr) =>
        tr.transaction ==
        '0x80e0954e19ab7b8a584295ba4addbe4bef35e4232640dc592c0819e160cd123e'
    );

    await persistTransactions(newtransactionsWithValues, true);

    const manifoldTransactions = transactionsWithValues.filter((tr) =>
      areEqualAddresses(tr.from_address, MANIFOLD)
    );

    await persistDistributionMinting(manifoldTransactions);

    if (response.pageKey) {
      await transactions(
        startingBlockResolved,
        response.latestBlock,
        response.pageKey
      );
    }
  } catch (e: any) {
    console.log('[TRANSACTIONS]', '[ETIMEDOUT!]', e, '[RETRYING PROCESS]');
    await transactions(startingBlock, latestBlock, pagKey);
  }
}

export async function memeLabOwners() {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const startingOwners: Owner[] = await fetchAllLabOwners();

  console.log('[OWNERS]', `[DB ${startingOwners.length}]`);

  const labOwners = await getAllOwners(alchemy, MEMELAB_CONTRACT);

  const newOwners: Owner[] = [];

  labOwners.map((ownerBalances) => {
    ownerBalances.tokenBalances.map((balance) => {
      const owner: Owner = {
        created_at: new Date(),
        wallet: ownerBalances.ownerAddress,
        token_id: fromHex(balance.tokenId),
        contract: MEMELAB_CONTRACT,
        balance: balance.balance
      };
      newOwners.push(owner);
    });
  });

  console.log(`[OWNERS ${newOwners.length}]`);

  let ownersDelta: Owner[] = [];

  newOwners.map((o) => {
    const existing = startingOwners.find((o1) => ownersMatch(o, o1));

    if (!existing || o.balance != existing.balance) {
      ownersDelta.push(o);
    }
  });

  startingOwners.map((o) => {
    const existing = newOwners.find((o1) => ownersMatch(o, o1));

    if (!existing) {
      o.balance = 0;
      ownersDelta.push(o);
    }
  });

  console.log('[OWNERS]', `[DELTA ${ownersDelta.length}]`);

  await persistOwners(ownersDelta, true);

  return ownersDelta;
}

export async function memeLabExtendedData() {
  let nfts: LabNFT[] = await fetchAllMemeLabNFTs();
  let owners: Owner[] = await fetchAllLabOwners();

  console.log('[MEMES EXTENDED DATA]', `[NFTS ${nfts.length}]`);

  const labMeta: LabExtendedData[] = [];

  nfts.map((nft) => {
    const tokenWallets = owners.filter(
      (tw) =>
        !areEqualAddresses(NULL_ADDRESS, tw.wallet) && tw.token_id == nft.id
    );

    let edition_size = 0;
    let museum_holdings = 0;
    let edition_size_cleaned = 0;
    tokenWallets.map((tw) => {
      if (!areEqualAddresses(tw.wallet, SIX529_MUSEUM.toUpperCase())) {
        edition_size_cleaned += tw.balance;
      } else {
        museum_holdings += tw.balance;
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
      percent_unique_cleaned_rank: -1
    };
    labMeta.push(meta);
  });

  labMeta.map((lm) => {
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
  });

  await persistLabExtendedData(labMeta);

  return labMeta;
}
