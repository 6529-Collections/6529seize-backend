import { GetOwnersForContractWithTokenBalancesResponse } from 'alchemy-sdk';
import { getAlchemyInstance } from '../alchemy';

export interface OwnedNft {
  wallet: string;
  contract: string;
  token_id: number;
  balance: number;
}

export async function getOwnersForContracts(
  contracts: string[]
): Promise<OwnedNft[]> {
  const owned = await getAllOwnersFromAlchemy(contracts);
  return owned;
}

async function getAllOwnersFromAlchemy(
  contracts: string[]
): Promise<OwnedNft[]> {
  const owned = new Map<string, OwnedNft>();

  for (const contract of contracts) {
    let pageKey: string | undefined = undefined;
    let response: GetOwnersForContractWithTokenBalancesResponse;
    do {
      response = await getOwnersFromAlchemyPage(contract, pageKey);
      response.owners.forEach((owner) => {
        owner.tokenBalances.forEach((balance) => {
          const key = `${owner.ownerAddress}-${contract}-${balance.tokenId}`;
          const myOwned = owned.get(key);
          if (myOwned) {
            myOwned.balance += parseInt(balance.balance);
          } else {
            owned.set(key, {
              wallet: owner.ownerAddress,
              contract: contract,
              token_id: parseInt(balance.tokenId),
              balance: parseInt(balance.balance)
            });
          }
        });
      });
      pageKey = response.pageKey;
    } while (pageKey);
  }

  return Array.from(owned.values());
}

async function getOwnersFromAlchemyPage(
  contract: string,
  pageKey: string | undefined
) {
  const alchemy = getAlchemyInstance();
  return await alchemy.nft.getOwnersForContract(contract, {
    withTokenBalances: true,
    pageKey: pageKey
  });
}
