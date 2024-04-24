import { NftContractOwner } from 'alchemy-sdk';
import { getAlchemyInstance } from '../alchemy';
import { NFTOwner } from '../entities/INFTOwner';

export async function fetchNftOwners(
  block: number,
  contract: string
): Promise<NFTOwner[]> {
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
  const alchemy = getAlchemyInstance();
  const owners = await alchemy.nft.getOwnersForContract(contract, {
    block: block.toString(),
    withTokenBalances: true,
    pageKey: page
  });
  return owners;
}
