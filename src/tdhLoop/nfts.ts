import { Alchemy, Nft } from 'alchemy-sdk';
import {
  ALCHEMY_SETTINGS,
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  NEXTGEN_CONTRACT
} from '../constants';
import { NFT } from '../entities/INFT';
import { persistNFTs } from '../db';
import { RequestInfo, RequestInit } from 'node-fetch';
import { Logger } from '../logging';

const logger = Logger.get('NFTS');

const fetch = (url: RequestInfo, init?: RequestInit) =>
  import('node-fetch').then(({ default: fetch }) => fetch(url, init));

let alchemy: Alchemy;

export async function getAllNfts(): Promise<{
  memes: NFT[];
  gradients: NFT[];
  nextgen: NFT[];
}> {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const memes: NFT[] = await getAllNFTs(MEMES_CONTRACT);
  const gradients: NFT[] = await getAllNFTs(GRADIENT_CONTRACT);
  const nextgen: NFT[] = await getAllNFTs(NEXTGEN_CONTRACT);

  const all = [...memes, ...gradients, ...nextgen];
  await persistNFTs(all);
  return {
    memes,
    gradients,
    nextgen
  };
}

async function getAllNFTs(
  contract: string,
  nfts: Nft[] = [],
  key = ''
): Promise<NFT[]> {
  const response = await getNFTResponse(alchemy, contract, key);
  const newKey = response.pageKey;
  nfts = nfts.concat(response.nfts);

  if (newKey) {
    return getAllNFTs(contract, nfts, newKey);
  }

  return nfts.map((nft) => {
    return {
      contract: nft.contract.address,
      id: parseInt(nft.tokenId),
      mint_date: nft.mint?.timestamp ?? ''
    };
  });
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
