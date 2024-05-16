import { NftContractOwner } from 'alchemy-sdk';
import { NFTOwner } from '../entities/INFTOwner';
import { Logger } from '../logging';

const logger = Logger.get('NFT_OWNERS');

interface OwnersApiResponse {
  ownerAddresses: NftContractOwner[];
  pageKey?: string;
}

export async function fetchNftOwners(
  block: number,
  contract: string
): Promise<NFTOwner[]> {
  logger.info(`[FETCHING NFT OWNERS] [BLOCK ${block}] [CONTRACT ${contract}]`);
  const contractOwners = await getOwners(block, contract);

  return contractOwners.flatMap((owner) =>
    owner.tokenBalances.map((nft) => ({
      address: owner.ownerAddress.toLowerCase(),
      contract: contract.toLowerCase(),
      token_id: parseInt(nft.tokenId),
      balance: parseInt(nft.balance)
    }))
  );
}

async function getOwners(
  block: number,
  contract: string
): Promise<NftContractOwner[]> {
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
  const baseUrl = `https://eth-mainnet.g.alchemy.com/nft/v2/${process.env.ALCHEMY_API_KEY}/getOwnersForContract`;
  const urlParams = new URLSearchParams({
    contractAddress: contract,
    block: block.toString(),
    withTokenBalances: 'true',
    ...(page ? { pageKey: page } : {})
  });
  const url = `${baseUrl}?${urlParams.toString()}`;
  const response = await fetch(url);
  const data = (await response.json()) as OwnersApiResponse;

  return {
    owners: data.ownerAddresses,
    pageKey: data.pageKey
  };
}
