import { Alchemy, OwnedBaseNft } from 'alchemy-sdk';
import { getAlchemyInstance } from '../alchemy';

export async function getNftsForOwner(address: string, contracts: string[]) {
  const alchemy = getAlchemyInstance();
  const owned = await fetchAllPages(alchemy, address, contracts);
  return owned;
}

async function fetchAllPages(
  alchemy: Alchemy,
  address: string,
  contracts: string[]
): Promise<OwnedBaseNft[]> {
  const owned: OwnedBaseNft[] = [];

  let pageKey: string | undefined = undefined;
  let response;
  do {
    response = await getResponse(alchemy, address, contracts, pageKey);
    owned.push(...response.ownedNfts);
    pageKey = response.pageKey;
  } while (pageKey);

  return owned;
}

async function getResponse(
  alchemy: Alchemy,
  address: string,
  contracts: string[],
  pageKey: string | undefined
) {
  return await alchemy.nft.getNftsForOwner(address, {
    contractAddresses: contracts,
    omitMetadata: true,
    pageKey: pageKey
  });
}
