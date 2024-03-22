import { areEqualAddresses } from '../helpers';
import {
  fetchAllNftOwners,
  getMaxNftOwnersBlockReference,
  persistConsolidatedNftOwners,
  persistNftOwners
} from './db.nft_owners';
import { Logger } from '../logging';
import { OwnedNft, getOwnersForContracts } from './owners';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';
import {
  getNextgenNetwork,
  NEXTGEN_CORE_CONTRACT
} from '../nextgen/nextgen_constants';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '../constants';
import {
  fetchMaxTransactionsBlockNumber,
  fetchTransactionAddressesFromBlock,
  fetchWalletConsolidationKeysViewForWallet
} from '../db';

const logger = Logger.get('NFT_OWNERS');

export const updateNftOwners = async (reset?: boolean) => {
  const NEXTGEN_CONTRACT = NEXTGEN_CORE_CONTRACT[getNextgenNetwork()];

  const allContracts = [
    MEMES_CONTRACT,
    MEMELAB_CONTRACT,
    GRADIENT_CONTRACT,
    NEXTGEN_CONTRACT
  ];

  const lastOwnersBlock = await getMaxNftOwnersBlockReference();

  reset = reset || lastOwnersBlock === 0;

  const blockReference = await fetchMaxTransactionsBlockNumber();

  logger.info(
    `[lastOwnersBlock ${lastOwnersBlock}] : [blockReference ${blockReference}] : [RESET ${reset}] : [FETCHING OWNERS...]`
  );
  const allOwners: OwnedNft[] = await getOwnersForContracts(allContracts);
  logger.info(`[OWNERS ${allOwners.length.toLocaleString()}]`);

  const addresses = new Set<string>();
  if (reset) {
    allOwners.forEach((o) => {
      addresses.add(o.wallet.toLowerCase());
    });
  } else {
    const transactionAddresses: {
      from_address: string;
      to_address: string;
    }[] = await fetchTransactionAddressesFromBlock(
      allContracts,
      lastOwnersBlock,
      blockReference
    );
    transactionAddresses.forEach((wallet) => {
      addresses.add(wallet.from_address.toLowerCase());
      addresses.add(wallet.to_address.toLowerCase());
    });
  }

  logger.info({
    owners: allOwners.length.toLocaleString(),
    addresses: addresses.size.toLocaleString()
  });

  if (addresses.size > 0) {
    logger.info(`[CALCULATING DELTA...]`);
    const ownersDelta = await getOwnersDelta(
      blockReference,
      addresses,
      allOwners,
      reset
    );

    logger.info({
      owners: allOwners.length.toLocaleString(),
      ownersDelta: ownersDelta.length.toLocaleString()
    });

    await persistNftOwners(addresses, ownersDelta, reset);
    await consolidateNftOwners(addresses, reset);
  } else {
    logger.info(`[NO CHANGES]`);
  }
};

function ownersMatch(o1: NFTOwner, o2: OwnedNft) {
  if (o1.token_id != o2.token_id) return false;
  if (!areEqualAddresses(o1.wallet, o2.wallet)) return false;
  if (!areEqualAddresses(o1.contract, o2.contract)) return false;
  return true;
}

export async function getOwnersDelta(
  blockReference: number,
  addresses: Set<string>,
  allOwners: OwnedNft[],
  reset: boolean
) {
  if (reset) {
    return allOwners.map((o) => {
      return {
        wallet: o.wallet.toLowerCase(),
        contract: o.contract.toLowerCase(),
        token_id: o.token_id,
        balance: o.balance,
        block_reference: blockReference
      };
    });
  }

  const ownersDelta: NFTOwner[] = [];

  addresses.forEach((address) => {
    const addressOwned = allOwners.filter((o) =>
      areEqualAddresses(o.wallet, address)
    );
    addressOwned.forEach((o) => {
      ownersDelta.push({
        wallet: o.wallet.toLowerCase(),
        contract: o.contract.toLowerCase(),
        token_id: o.token_id,
        balance: o.balance,
        block_reference: blockReference
      });
    });
  });

  return ownersDelta;
}

export async function consolidateNftOwners(
  addresses: Set<string>,
  reset?: boolean
) {
  if (reset) {
    const owners = await fetchAllNftOwners();
    addresses.clear();
    owners.forEach((owner) => {
      addresses.add(owner.wallet);
    });
  }

  logger.info(
    `[CONSOLIDATING OWNERS FOR ${addresses.size.toLocaleString()} WALLETS] : [RESET ${reset}]`
  );

  if (!addresses.size) {
    logger.info(`[NO WALLETS TO CONSOLIDATE]`);
    return;
  }

  const upsertDeltaMap = new Map<string, ConsolidatedNFTOwner[]>();
  const deleteDelta = new Set<string>();

  await Promise.all(
    Array.from(addresses).map(async (address) => {
      const consolidation = (
        await fetchWalletConsolidationKeysViewForWallet([address])
      )?.[0];

      let consolidationKey: string;
      let consolidationAddresses: string[] = [];
      if (!consolidation) {
        consolidationKey = address.toLowerCase();
        consolidationAddresses.push(address.toLowerCase());
      } else {
        consolidationKey = consolidation.consolidation_key;
        consolidationAddresses = consolidation.consolidation_key.split('-');
      }

      const owners = await fetchAllNftOwners(
        undefined,
        Array.from(consolidationAddresses)
      );

      const consolidatedOwners = getConsolidatedOwners(
        consolidationKey,
        owners
      );

      upsertDeltaMap.set(consolidationKey, consolidatedOwners);

      consolidationAddresses.forEach((address) => {
        deleteDelta.add(address);
      });
    })
  );

  const upsertDelta = Array.from(upsertDeltaMap.values()).flat();

  logger.info({
    message: '[OWNERS CONSOLIDATED]',
    upsertDelta: upsertDelta.length.toLocaleString(),
    deleteDeltaWallets: deleteDelta.size.toLocaleString()
  });
  await persistConsolidatedNftOwners(upsertDelta, deleteDelta, reset);
}

function getConsolidatedOwners(
  consolidationKey: string,
  owners: NFTOwner[]
): ConsolidatedNFTOwner[] {
  const consolidatedOwnersMap = new Map<string, ConsolidatedNFTOwner>();

  owners.forEach((owner) => {
    const key = `${owner.contract}-${owner.token_id}`;
    let consolidatedOwner = consolidatedOwnersMap.get(key);
    if (!consolidatedOwner) {
      consolidatedOwner = {
        consolidation_key: consolidationKey,
        contract: owner.contract,
        token_id: owner.token_id,
        balance: 0
      };
      consolidatedOwnersMap.set(key, consolidatedOwner);
    }
    consolidatedOwner.balance += owner.balance;
  });
  return Array.from(consolidatedOwnersMap.values()).filter(
    (o) => o.balance > 0
  );
}
