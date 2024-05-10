import { Alchemy, Nft } from 'alchemy-sdk';
import {
  ALCHEMY_SETTINGS,
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  MEME_8_EDITION_BURN_ADJUSTMENT,
  NEXTGEN_CONTRACT
} from '../constants';
import { NFT } from '../entities/INFT';
import { fetchMintDate } from '../db';
import { NFTOwner } from '../entities/INFTOwner';

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

  const memes: Nft[] = await getAllNFTsForContract(MEMES_CONTRACT);
  const parsedMemes: NFT[] = await Promise.all(
    memes.map(async (m) => {
      const tokenId = parseInt(m.tokenId);
      const owners = memeOwners.filter(
        (o) => o.token_id === parseInt(m.tokenId)
      );

      let editionSize = owners.reduce((acc, o) => acc + o.balance, 0);
      if (tokenId === 8) {
        editionSize += MEME_8_EDITION_BURN_ADJUSTMENT;
      }

      const season =
        m.raw.metadata.attributes.find(
          (m: any) => m.trait_type === 'Type - Season'
        )?.value ?? -1;

      return {
        contract: m.contract.address.toLowerCase(),
        id: tokenId,
        mint_date: await getMintDate(m),
        edition_size: editionSize,
        season,
        tdh: 0
      };
    })
  );

  const gradients: Nft[] = await getAllNFTsForContract(GRADIENT_CONTRACT);
  const parsedGradients: NFT[] = await Promise.all(
    gradients.map(async (g) => {
      return {
        contract: g.contract.address.toLowerCase(),
        id: parseInt(g.tokenId),
        mint_date: await getMintDate(g),
        edition_size: gradients.length,
        tdh: 0
      };
    })
  );

  const nextgen: Nft[] = await getAllNFTsForContract(NEXTGEN_CONTRACT);
  const nextgenCollections = new Map<number, number[]>();
  nextgen.forEach((n) => {
    const collectionId = Math.round(parseInt(n.tokenId) / 10000000000);
    const collection = nextgenCollections.get(collectionId) || [];
    collection.push(parseInt(n.tokenId));
    nextgenCollections.set(collectionId, collection);
  });
  const parsedNextgen: NFT[] = await Promise.all(
    nextgen.map(async (n) => {
      const collectionId = Math.round(parseInt(n.tokenId) / 10000000000);
      const collection = nextgenCollections.get(collectionId) || [];
      return {
        contract: n.contract.address.toLowerCase(),
        id: parseInt(n.tokenId),
        mint_date: await getMintDate(n),
        edition_size: collection.length,
        tdh: 0
      };
    })
  );

  return {
    memes: parsedMemes,
    gradients: parsedGradients,
    nextgen: parsedNextgen
  };
}

async function getAllNFTsForContract(
  contract: string,
  nfts: Nft[] = [],
  key = ''
): Promise<Nft[]> {
  const response = await getNFTResponse(alchemy, contract, key);
  const newKey = response.pageKey;
  nfts = nfts.concat(response.nfts);

  if (newKey) {
    return getAllNFTsForContract(contract, nfts, newKey);
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

async function getMintDate(m: Nft) {
  return await fetchMintDate(m.contract.address, parseInt(m.tokenId));
}
