import { NftContractOwner } from 'alchemy-sdk';
import fetch from 'node-fetch';
import { Time } from '../time';
import { Logger } from '../logging';

const logger = Logger.get('OWNERS');

interface OwnersApiResponse {
  ownerAddresses: NftContractOwner[];
  pageKey?: string;
}

export interface OwnedNft {
  wallet: string;
  contract: string;
  token_id: number;
  balance: number;
}

export async function getOwnersForContracts(
  contracts: string[],
  block?: number
): Promise<OwnedNft[]> {
  return await getAllOwnersFromAlchemy(contracts, block);
}

async function getAllOwnersFromAlchemy(
  contracts: string[],
  block?: number
): Promise<OwnedNft[]> {
  const owned = new Map<string, OwnedNft>();

  for (const contract of contracts) {
    const owners = await getOwners(block ?? -1, contract);
    owners.forEach((owner) => {
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
  }

  return Array.from(owned.values());
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
  for (let attempt = 1; attempt <= 3; attempt++) {
    const baseUrl = `https://eth-mainnet.g.alchemy.com/nft/v2/${process.env.ALCHEMY_API_KEY}/getOwnersForContract`;
    const urlParams = new URLSearchParams({
      contractAddress: contract,
      withTokenBalances: 'true',
      ...(page ? { pageKey: page } : {})
    });
    if (block > 0) {
      urlParams.append('block', block.toString());
    }

    const url = `${baseUrl}?${urlParams.toString()}`;

    const response = await fetch(url);
    try {
      const data = (await response.json()) as OwnersApiResponse;

      return {
        owners: data.ownerAddresses,
        pageKey: data.pageKey
      };
    } catch (e: any) {
      const message = `Unable to get owners from ${url} (attempt ${attempt}) Error: ${JSON.stringify(
        e
      )}. Response Body: ${await response.text().catch(() => '')}`;
      if (attempt === 3) {
        throw new Error(message);
      } else {
        const delay = Time.seconds(attempt * 10);
        logger.error(`${message}. Waiting for ${delay} before trying again`);
      }
    }
  }
  throw new Error('Unreachable code');
}
