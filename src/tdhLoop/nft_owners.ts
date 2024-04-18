import { NftContractOwner } from 'alchemy-sdk';
import { getAlchemyInstance } from '../alchemy';
import { Logger } from '../logging';
import {
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  NEXTGEN_CONTRACT
} from '../constants';

const logger = Logger.get('NFT_OWNERS');

export async function fetchNftOwners(block: number) {
  logger.info(`Fetching NFT owners for block ${block}`);

  const contracts = [MEMES_CONTRACT, GRADIENT_CONTRACT, NEXTGEN_CONTRACT];
  let owners: NftContractOwner[] = [];
  for (const contract of contracts) {
    owners = owners.concat(await getOwners(block, contract));
  }
  logger.info(`Found ${owners.length} NFT owners`);
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
