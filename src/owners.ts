import {
  ALCHEMY_SETTINGS,
  GRADIENT_CONTRACT,
  MEMES_CONTRACT
} from './constants';
import { Owner } from './entities/IOwner';
import { Alchemy, fromHex, NftContractOwner } from 'alchemy-sdk';
import { areEqualAddresses } from './helpers';
import { persistOwners, fetchAllOwners } from './db';

let alchemy: Alchemy;

export function ownersMatch(o1: Owner, o2: Owner) {
  if (o1.token_id != o2.token_id) return false;
  if (!areEqualAddresses(o1.wallet, o2.wallet)) return false;
  if (!areEqualAddresses(o1.contract, o2.contract)) return false;
  return true;
}

async function getOwnersResponse(alchemy: Alchemy, contract: string, key: any) {
  const response = await alchemy.nft.getOwnersForContract(contract, {
    withTokenBalances: true,
    pageKey: key ? key : undefined
  });
  return response;
}

export async function getAllOwners(
  alchemy: Alchemy,
  contract: string,
  owners: any[] = [],
  key: string = ''
): Promise<NftContractOwner[]> {
  const response = await getOwnersResponse(alchemy, contract, key);
  const newKey = response.pageKey;
  owners = owners.concat(response.owners);

  if (newKey) {
    return getAllOwners(alchemy, contract, owners, newKey);
  }

  return owners;
}

export const findOwners = async () => {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const startingOwners: Owner[] = await fetchAllOwners();

  console.log(new Date(), '[OWNERS]', `[DB ${startingOwners.length}]`);

  const memesOwners = await getAllOwners(alchemy, MEMES_CONTRACT);

  const gradientsOwners = await getAllOwners(alchemy, GRADIENT_CONTRACT);

  console.log(
    new Date(),
    '[OWNERS]',
    `[MEMES ${memesOwners.length}]`,
    `[GRADIENTS ${gradientsOwners.length}]`
  );

  const newOwners: Owner[] = [];

  memesOwners.map((ownerBalances) => {
    ownerBalances.tokenBalances.map((balance) => {
      const owner: Owner = {
        created_at: new Date(),
        wallet: ownerBalances.ownerAddress,
        token_id: fromHex(balance.tokenId),
        contract: MEMES_CONTRACT,
        balance: balance.balance
      };
      newOwners.push(owner);
    });
  });

  gradientsOwners.map((ownerBalances) => {
    ownerBalances.tokenBalances.map((balance) => {
      const owner: Owner = {
        created_at: new Date(),
        wallet: ownerBalances.ownerAddress,
        token_id: fromHex(balance.tokenId),
        contract: GRADIENT_CONTRACT,
        balance: balance.balance
      };
      newOwners.push(owner);
    });
  });

  console.log(
    new Date(),
    `[OWNERS ${newOwners.length}]`,
    `[MEMES ${memesOwners.length}]`,
    `[GRADIENTS ${gradientsOwners.length}]`
  );

  let ownersDelta: Owner[] = [];

  newOwners.map((o) => {
    const existing = startingOwners.find((o1) => ownersMatch(o, o1));

    if (!existing || o.balance != existing.balance) {
      ownersDelta.push(o);
    }
  });

  startingOwners.map((o) => {
    const existing = newOwners.find((o1) => ownersMatch(o, o1));

    if (!existing) {
      o.balance = 0;
      ownersDelta.push(o);
    }
  });

  console.log(new Date(), '[OWNERS]', `[DELTA ${ownersDelta.length}]`);

  await persistOwners(ownersDelta);

  return ownersDelta;
};
