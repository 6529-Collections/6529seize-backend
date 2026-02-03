import {
  MEME_8_EDITION_BURN_ADJUSTMENT,
  MEMES_CONTRACT,
  NULL_ADDRESS
} from '@/constants';
import { NFTOwner } from '../entities/INFTOwner';
import { Transaction } from '../entities/ITransaction';
import { equalIgnoreCase } from '../strings';

export interface NFTOwnerDelta {
  address: string;
  contract: string;
  tokenId: number;
  delta: number;
}

async function extractNFTOwnerDeltas(
  transactions: Transaction[]
): Promise<NFTOwnerDelta[]> {
  const ownersMap: Record<string, NFTOwnerDelta> = {};

  for (const transaction of transactions) {
    const fromKey = `${transaction.contract}:${transaction.token_id}:${transaction.from_address}`;
    const toKey = `${transaction.contract}:${transaction.token_id}:${transaction.to_address}`;

    if (!equalIgnoreCase(transaction.from_address, NULL_ADDRESS)) {
      if (!ownersMap[fromKey]) {
        ownersMap[fromKey] = {
          address: transaction.from_address.toLowerCase(),
          contract: transaction.contract.toLowerCase(),
          tokenId: transaction.token_id,
          delta: -transaction.token_count
        };
      } else {
        ownersMap[fromKey].delta -= transaction.token_count;
      }
    }

    if (!ownersMap[toKey]) {
      ownersMap[toKey] = {
        address: transaction.to_address.toLowerCase(),
        contract: transaction.contract.toLowerCase(),
        tokenId: transaction.token_id,
        delta: transaction.token_count
      };
    } else {
      ownersMap[toKey].delta += transaction.token_count;
    }
  }

  return Object.values(ownersMap).filter((o) => o.delta !== 0);
}

export async function extractNFTOwners(
  blockReference: number,
  transactions: Transaction[]
): Promise<NFTOwner[]> {
  const deltas = await extractNFTOwnerDeltas(transactions);
  return deltas
    .map((d) => {
      return {
        contract: d.contract,
        wallet: d.address,
        token_id: d.tokenId,
        balance: d.delta,
        block_reference: blockReference
      };
    })
    .filter((o) => o.balance > 0);
}

export async function extractMemesEditionSizes(
  transactions: Transaction[]
): Promise<Record<number, number>> {
  const nftsMap: Record<number, number> = {};

  transactions
    .filter((t) => equalIgnoreCase(t.contract, MEMES_CONTRACT))
    .filter((t) => equalIgnoreCase(t.from_address, NULL_ADDRESS))
    .forEach((transaction) => {
      const { token_id } = transaction;
      if (!nftsMap[token_id]) {
        nftsMap[token_id] = transaction.token_count;
      } else {
        nftsMap[token_id] += transaction.token_count;
      }
    });

  nftsMap[8] += MEME_8_EDITION_BURN_ADJUSTMENT;

  const sorted = Object.fromEntries(
    Object.entries(nftsMap).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
  );

  return sorted;
}
