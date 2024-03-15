import { areEqualAddresses } from '../helpers';
import {
  fetchAllNftOwners,
  getMaxBlockReference,
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

export const findNftOwners = async (reset?: boolean) => {
  const NEXTGEN_CONTRACT = NEXTGEN_CORE_CONTRACT[getNextgenNetwork()];

  const allContracts = [
    MEMES_CONTRACT,
    MEMELAB_CONTRACT,
    GRADIENT_CONTRACT,
    NEXTGEN_CONTRACT
  ];

  const lastOwnersBlock = await getMaxBlockReference();

  reset = reset || lastOwnersBlock === 0;

  const blockReference = await fetchMaxTransactionsBlockNumber();

  logger.info(
    `[lastOwnersBlock ${lastOwnersBlock}] : [blockReference ${blockReference}] : [RESET ${reset}] : [FETCHING OWNERS...]`
  );
  const owners: OwnedNft[] = await getOwnersForContracts(allContracts);
  logger.info(`[OWNERS ${owners.length.toLocaleString()}]`);

  const addresses = new Set<string>();
  let changedOwners: OwnedNft[];
  if (reset) {
    changedOwners = owners;
    owners.forEach((o) => {
      addresses.add(o.wallet.toLowerCase());
    });
  } else {
    const transactionAddresses: {
      from_address: string;
      to_address: string;
    }[] = await fetchTransactionAddressesFromBlock(
      allContracts,
      lastOwnersBlock
    );
    transactionAddresses.forEach((wallet) => {
      addresses.add(wallet.from_address.toLowerCase());
      addresses.add(wallet.to_address.toLowerCase());
    });
    changedOwners = owners.filter((o) => addresses.has(o.wallet.toLowerCase()));
  }

  logger.info({
    owners: owners.length.toLocaleString(),
    addresses: addresses.size.toLocaleString(),
    changedOwners: changedOwners.length.toLocaleString()
  });

  if (changedOwners.length > 0) {
    logger.info(`[CALCULATING DELTA...]`);
    const ownersDelta = await getOwnersDelta(
      allContracts,
      blockReference,
      addresses,
      changedOwners,
      reset
    );
    const upsertDelta = ownersDelta.filter((o) => o.balance > 0);
    const deleteDelta = ownersDelta.filter((o) => 0 >= o.balance);
    logger.info({
      owners: owners.length.toLocaleString(),
      ownersDelta: ownersDelta.length.toLocaleString(),
      upsertDelta: upsertDelta.length.toLocaleString(),
      deleteDelta: deleteDelta.length.toLocaleString()
    });

    if (upsertDelta.length > 0 || deleteDelta.length > 0) {
      await persistNftOwners(upsertDelta, deleteDelta, reset);
      await consolidateNftOwners(addresses, reset);
    } else {
      logger.info(`[NO CHANGES]`);
    }
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
  contracts: string[],
  blockReference: number,
  addresses: Set<string>,
  newOwners: OwnedNft[],
  reset: boolean
) {
  if (reset) {
    return newOwners.map((o) => {
      return {
        wallet: o.wallet.toLowerCase(),
        contract: o.contract.toLowerCase(),
        token_id: o.token_id,
        balance: o.balance,
        block_reference: blockReference
      };
    });
  }

  const startingOwners = await fetchAllNftOwners(
    contracts,
    Array.from(addresses)
  );

  logger.info(
    `[STARTING OWNERS ${startingOwners.length.toLocaleString()}] : [NEW OWNERS ${newOwners.length.toLocaleString()}]`
  );

  const ownersDelta: NFTOwner[] = [];

  newOwners.forEach((o) => {
    const existing = startingOwners.find((o1) => ownersMatch(o1, o));

    if (!existing || o.balance != existing.balance) {
      ownersDelta.push({
        wallet: o.wallet.toLowerCase(),
        contract: o.contract.toLowerCase(),
        token_id: o.token_id,
        balance: o.balance,
        block_reference: blockReference
      });
    }
  });

  startingOwners.forEach((o) => {
    const existing = newOwners.find((o1) => ownersMatch(o, o1));
    if (!existing) {
      o.balance = 0;
      ownersDelta.push(o);
    }
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

  const upsertDelta: ConsolidatedNFTOwner[] = [];
  const deleteDelta = new Set<string>();

  const consolidationViews = await fetchWalletConsolidationKeysViewForWallet(
    Array.from(addresses)
  );

  const nftOwners = await fetchAllNftOwners(undefined, Array.from(addresses));

  logger.info(
    `[UNIQUE WALLETS ${addresses.size.toLocaleString()}] : [OWNERS ${nftOwners.length.toLocaleString()}]`
  );

  const usedConsolidationKeys = new Set<string>();

  addresses.forEach((wallet) => {
    const consolidation = consolidationViews.find((consolidation) =>
      areEqualAddresses(consolidation.wallet, wallet)
    );

    let consolidationKey: string;
    let consolidationAddresses: string[] = [];
    if (!consolidation) {
      consolidationKey = wallet.toLowerCase();
      consolidationAddresses.push(wallet.toLowerCase());
    } else {
      consolidationKey = consolidation.consolidation_key;
      consolidationAddresses = consolidation.consolidation_key.split('-');
    }

    if (usedConsolidationKeys.has(consolidationKey)) {
      return;
    }

    const owners = [...nftOwners].filter((owner) =>
      consolidationAddresses.some((a) => areEqualAddresses(a, owner.wallet))
    );

    const consolidatedOwners = getConsolidatedOwners(consolidationKey, owners);

    upsertDelta.push(...consolidatedOwners);

    consolidationAddresses.forEach((address) => {
      deleteDelta.add(address);
    });
    usedConsolidationKeys.add(consolidationKey);
  });

  logger.info({
    message: '[OWNERS CONSOLIDATED]',
    upsertDelta: upsertDelta.length.toLocaleString(),
    deleteDelta: deleteDelta.size.toLocaleString()
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
  return Array.from(consolidatedOwnersMap.values());
}
