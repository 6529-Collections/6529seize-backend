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
  NULL_ADDRESS
} from './constants';
import { LabNFT, NFTWithExtendedData } from './entities/INFT';
import { Transaction } from './entities/ITransaction';
import { areEqualAddresses } from './helpers';
import {
  createMemeLabNftsTable,
  createMemeLabTransactionsTable,
  fetchAllMemeLabNFTs,
  persistTransactions,
  fetchLatestLabTransactionsBlockNumber,
  fetchAllMemeLabTransactions,
  persistLabNFTS,
  fetchAllArtists,
  persistArtists,
  addMemeLabColumnToArtists,
  fetchAllLabOwners,
  createMemeLabOwnersTable,
  persistOwners,
  fetchMemesWithSeason
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
  startingTransactions: Transaction[]
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

      const fullMetadata = await alchemy.nft.getNftMetadata(
        MEMELAB_CONTRACT,
        tokenId
      );

      const createdTransactions = startingTransactions.filter(
        (t) =>
          t.token_id == tokenId &&
          areEqualAddresses(t.contract, MEMELAB_CONTRACT) &&
          areEqualAddresses(NULL_ADDRESS, t.from_address)
      );

      const burntTransactions = startingTransactions.filter(
        (t) =>
          t.token_id == tokenId &&
          areEqualAddresses(t.contract, MEMELAB_CONTRACT) &&
          areEqualAddresses(NULL_ADDRESS, t.to_address)
      );

      const firstMintTransaction = startingTransactions.find(
        (t) =>
          t.token_id == tokenId &&
          areEqualAddresses(t.contract, MEMELAB_CONTRACT) &&
          areEqualAddresses(MANIFOLD, t.from_address)
      );

      let mintPrice = 0;
      if (firstMintTransaction) {
        const mintTransaction = await alchemy.core.getTransaction(
          firstMintTransaction?.transaction
        );
        mintPrice = mintTransaction
          ? parseFloat(Utils.formatEther(mintTransaction.value))
          : 0;
      }
      let supply = 0;
      createdTransactions.map((mint) => {
        supply += mint.token_count;
      });
      burntTransactions.map((burn) => {
        supply -= burn.token_count;
      });

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
        supply: supply,
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
        meme_references: memeReferences
      };

      newNFTS.push(nft);
    })
  );
  console.log(`[NFTS]`, `[PROCESSED ${newNFTS.length} NEW NFTS]`);
  return newNFTS;
}

export const findNFTs = async (
  startingNFTS: LabNFT[],
  startingTransactions: Transaction[],
  reset?: boolean
) => {
  const allNFTs = await processNFTs(startingNFTS, startingTransactions);

  const nftChanged = allNFTs.some((n) => {
    const m = startingNFTS.find(
      (s) => areEqualAddresses(s.contract, n.contract) && s.id == n.id
    );
    if (m?.mint_price != n.mint_price) {
      return true;
    }
    if (m?.supply != n.supply) {
      return true;
    }
    return false;
  });

  console.log(`[NFTS]`, `[CHANGED ${nftChanged}]`, `[RESET ${reset}]`);

  return allNFTs;
};

export async function memeLabNfts(reset?: boolean) {
  await createMemeLabNftsTable();
  await addMemeLabColumnToArtists();

  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const nfts: LabNFT[] = await fetchAllMemeLabNFTs();
  const transactions: Transaction[] = await fetchAllMemeLabTransactions();
  const artists: Artist[] = await fetchAllArtists();

  const newNfts = await findNFTs(nfts, transactions, reset);
  const newArtists = await findArtists(artists, newNfts);
  await persistLabNFTS(newNfts);
  await persistArtists(newArtists);
}

export async function memeLabTransactions() {
  await createMemeLabTransactionsTable();
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

    await persistTransactions(transactionsWithValues, true);

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
  await createMemeLabOwnersTable();

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
