import { NftContractOwner } from 'alchemy-sdk';
import { getAlchemyInstance } from '../alchemy';
import { Logger } from '../logging';
import {
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  NEXTGEN_CONTRACT
} from '../constants';

const logger = Logger.get('NFT_OWNERS');

export async function fetchNftOwners(block: number, contract: string) {
  return await getOwners(block, contract);
}

async function getOwners(block: number, contract: string) {
  let page: string | undefined = '';
  let owners: NftContractOwner[] = [];
  do {
    const result = await getOwnersForPage(block, contract, page);
    owners = owners.concat(result.owners);
    page = result.pageKey;
  } while (page);
  return owners;
}

async function getOwnersForPage(block: number, contract: string, page: string) {
  const alchemy = getAlchemyInstance();
  const owners = await alchemy.nft.getOwnersForContract(contract, {
    block: block.toString(),
    withTokenBalances: true,
    pageKey: page
  });
  return owners;
}
