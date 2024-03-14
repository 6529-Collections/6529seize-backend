import { Alchemy } from 'alchemy-sdk';
import { getAlchemyInstance } from '../alchemy';
import { NFTOwner } from '../entities/INFTOwner';

export interface OwnedNft {
  wallet: string;
  contract: string;
  token_id: number;
  balance: number;
}

export async function getOwnersForContracts(
  contracts: string[]
): Promise<OwnedNft[]> {
  const alchemy = getAlchemyInstance();
  const owned = await fetchAllPages(alchemy, contracts);
  return owned;
}

async function fetchAllPages(
  alchemy: Alchemy,
  contracts: string[]
): Promise<OwnedNft[]> {
  const owned: OwnedNft[] = [];

  for (const contract of contracts) {
    let pageKey: string | undefined = undefined;
    let response;
    do {
      response = await getResponse(alchemy, contract, pageKey);
      response.owners.forEach((owner) => {
        owner.tokenBalances.forEach((balance) => {
          owned.push({
            wallet: owner.ownerAddress,
            contract: contract,
            token_id: parseInt(balance.tokenId),
            balance: parseInt(balance.balance)
          });
        });
      });
      pageKey = response.pageKey;
    } while (pageKey);
  }

  return owned;
}

async function getResponse(
  alchemy: Alchemy,
  contract: string,
  pageKey: string | undefined
) {
  return await alchemy.nft.getOwnersForContract(contract, {
    withTokenBalances: true,
    pageKey: pageKey
  });
}
