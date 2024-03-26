import { Alchemy } from 'alchemy-sdk';
import { getAlchemyInstance } from '../alchemy';

export async function getOwnersForContracts(
  contracts: string[]
): Promise<Set<string>> {
  const alchemy = getAlchemyInstance();
  const owned = await fetchAllPages(alchemy, contracts);
  return owned;
}

async function fetchAllPages(
  alchemy: Alchemy,
  contracts: string[]
): Promise<Set<string>> {
  const owned = new Set<string>();

  for (const contract of contracts) {
    let pageKey: string | undefined = undefined;
    let response;
    do {
      response = await getResponse(alchemy, contract, pageKey);
      response.owners.forEach((owner) => owned.add(owner));
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
  return await alchemy.nft.getOwnersForContract(contract, { pageKey });
}
