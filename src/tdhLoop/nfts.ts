import { Alchemy, Nft } from 'alchemy-sdk';
import {
  ALCHEMY_SETTINGS,
  GRADIENT_CONTRACT,
  MANIFOLD,
  MEMES_CONTRACT,
  NEXTGEN_CONTRACT,
  NULL_ADDRESS
} from '../constants';
import { NFT } from '../entities/INFT';
import { fetchAllTransactions, persistNFTs } from '../db';
import { NFTOwner } from '../entities/INFTOwner';
import { areEqualAddresses, isNullAddress } from '../helpers';
import { Transaction } from '../entities/ITransaction';

let alchemy: Alchemy;

export async function getAllNfts(memeOwners: NFTOwner[]): Promise<{
  memes: NFT[];
  gradients: NFT[];
  nextgen: NFT[];
}> {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const transactions: Transaction[] = await fetchAllTransactions();

  const memes: Nft[] = await getAllNFTs(MEMES_CONTRACT);
  const parsedMemes: NFT[] = memes.map((m) => {
    const tokenId = parseInt(m.tokenId);
    const info = getMemesInfo(transactions, tokenId);
    const season =
      m.raw.metadata.attributes.find(
        (m: any) => m.trait_type === 'Type - Season'
      )?.value ?? -1;
    return {
      contract: m.contract.address,
      id: tokenId,
      mint_date: info.firstMintTransaction?.transaction_date.toString(),
      edition_size: info.supply,
      season
    };
  });

  const gradients: Nft[] = await getAllNFTs(GRADIENT_CONTRACT);
  const parsedGradients: NFT[] = gradients.map((g) => {
    return {
      contract: g.contract.address,
      id: parseInt(g.tokenId),
      mint_date: g.mint?.timestamp,
      edition_size: gradients.length
    };
  });

  const nextgen: Nft[] = await getAllNFTs(NEXTGEN_CONTRACT);
  const nextgenCollections = new Map<number, number[]>();
  nextgen.forEach((n) => {
    const collectionId = Math.round(parseInt(n.tokenId) / 10000000000);
    let collection = nextgenCollections.get(collectionId) || [];
    collection.push(parseInt(n.tokenId));
    nextgenCollections.set(collectionId, collection);
  });
  const parsedNextgen: NFT[] = nextgen.map((n) => {
    const collectionId = Math.round(parseInt(n.tokenId) / 10000000000);
    const collection = nextgenCollections.get(collectionId) || [];
    return {
      contract: n.contract.address,
      id: parseInt(n.tokenId),
      mint_date: n.mint?.timestamp,
      edition_size: collection.length
    };
  });

  await persistNFTs([...parsedMemes, ...parsedGradients, ...parsedNextgen]);

  return {
    memes: parsedMemes,
    gradients: parsedGradients,
    nextgen: parsedNextgen
  };
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

async function getNFTResponse(alchemy: Alchemy, contract: string, key: any) {
  const settings = {
    pageKey: undefined
  };

  if (key) {
    settings.pageKey = key;
  }

  const response = await alchemy.nft.getNftsForContract(contract, settings);
  return response;
}

const getMemesInfo = (transactions: Transaction[], tokenId: number) => {
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

  let supply = createdTransactions.reduce(
    (acc, mint) => acc + mint.token_count,
    0
  );
  supply -= burntTransactions.reduce((acc, burn) => acc + burn.token_count, 0);

  return {
    supply,
    firstMintTransaction
  };
};
