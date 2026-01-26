import {
  fetchAllNftOwners,
  getMaxNftOwnersBlockReference,
  getNftOwnersSyncBlock,
  persistConsolidatedNftOwners,
  persistNftOwners,
  setNftOwnersSyncBlock
} from './db.nft_owners';
import { Logger } from '../logging';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';
import { Transaction } from '../entities/ITransaction';
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
  fetchTransactionsAfterBlock,
  fetchWalletConsolidationKeysViewForWallet
} from '../db';
import { ethTools } from '../eth-tools';

function deltaKey(wallet: string, contract: string, tokenId: number): string {
  return `${wallet.toLowerCase()}-${contract.toLowerCase()}-${tokenId}`;
}

function parseDeltaKey(
  key: string
): { wallet: string; contract: string; token_id: number } | null {
  const parts = key.split('-');
  if (parts.length !== 3) return null;
  const tokenId = parseInt(parts[2], 10);
  if (!Number.isFinite(tokenId)) return null;
  return {
    wallet: parts[0].toLowerCase(),
    contract: parts[1].toLowerCase(),
    token_id: tokenId
  };
}

function dedupeTransactionsByTransfer(
  transactions: Transaction[]
): Transaction[] {
  const seen = new Set<string>();
  return transactions.filter((tx) => {
    const key = `${tx.transaction}-${tx.from_address}-${tx.to_address}-${tx.contract}-${tx.token_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ownersToBalanceMap(owners: NFTOwner[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const o of owners) {
    const key = deltaKey(o.wallet, o.contract, o.token_id);
    map.set(key, (map.get(key) ?? 0) + o.balance);
  }
  return map;
}

function buildBalanceMapFromTransactions(
  transactions: Transaction[]
): Map<string, number> {
  const deduped = dedupeTransactionsByTransfer(transactions);
  const balance = new Map<string, number>();
  for (const tx of deduped) {
    const contract = tx.contract.toLowerCase();
    const tokenId = Number(tx.token_id);
    const count = tx.token_count != null ? Number(tx.token_count) : 0;
    const fromKey = deltaKey(tx.from_address, contract, tokenId);
    const toKey = deltaKey(tx.to_address, contract, tokenId);
    balance.set(fromKey, (balance.get(fromKey) ?? 0) - count);
    balance.set(toKey, (balance.get(toKey) ?? 0) + count);
  }
  return balance;
}

function buildOwnersDeltaFromTransactions(
  blockReference: number,
  addresses: Set<string>,
  newTransactions: Transaction[],
  baseBalanceFromReplay: Map<string, number>
): NFTOwner[] {
  const delta = buildBalanceMapFromTransactions(newTransactions);
  const ownersDelta: NFTOwner[] = [];
  const processedKeys = new Set<string>();
  for (const [key, baseBal] of Array.from(baseBalanceFromReplay)) {
    const parsed = parseDeltaKey(key);
    if (!parsed || !addresses.has(parsed.wallet)) continue;
    processedKeys.add(key);
    const newBalance = baseBal + (delta.get(key) ?? 0);
    if (newBalance > 0) {
      ownersDelta.push({
        wallet: parsed.wallet,
        contract: parsed.contract,
        token_id: parsed.token_id,
        balance: newBalance,
        block_reference: blockReference
      });
    }
  }
  for (const [key, change] of Array.from(delta)) {
    if (processedKeys.has(key) || change <= 0) continue;
    const parsed = parseDeltaKey(key);
    if (!parsed || !addresses.has(parsed.wallet)) continue;
    ownersDelta.push({
      wallet: parsed.wallet,
      contract: parsed.contract,
      token_id: parsed.token_id,
      balance: change,
      block_reference: blockReference
    });
  }
  return ownersDelta;
}

function buildFullOwnersFromTransactions(
  blockReference: number,
  transactions: Transaction[]
): { ownersDelta: NFTOwner[]; addresses: Set<string> } {
  const balance = buildBalanceMapFromTransactions(transactions);
  const ownersDelta: NFTOwner[] = [];
  const addresses = new Set<string>();
  for (const [key, bal] of Array.from(balance)) {
    if (bal <= 0) continue;
    const parsed = parseDeltaKey(key);
    if (!parsed || ethTools.isNullOrDeadAddress(parsed.wallet)) continue;
    addresses.add(parsed.wallet);
    ownersDelta.push({
      wallet: parsed.wallet,
      contract: parsed.contract,
      token_id: parsed.token_id,
      balance: bal,
      block_reference: blockReference
    });
  }
  return { ownersDelta, addresses };
}

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
  const syncBlock = await getNftOwnersSyncBlock();

  const resetReasonSyncMismatch =
    lastOwnersBlock > 0 && syncBlock !== lastOwnersBlock;
  reset = reset || lastOwnersBlock === 0 || resetReasonSyncMismatch;

  const blockReference = await fetchMaxTransactionsBlockNumber();
  if (resetReasonSyncMismatch) {
    logger.info(
      `[RESET: sync block mismatch (sync=${syncBlock} vs max_ref=${lastOwnersBlock}) - full replay]`
    );
  }

  let addresses: Set<string>;
  let ownersDelta: NFTOwner[];

  if (reset) {
    logger.info(
      `[lastOwnersBlock ${lastOwnersBlock}] : [blockReference ${blockReference}] : [RESET] : [FETCHING ALL TRANSACTIONS...]`
    );
    const transactions = await fetchTransactionsAfterBlock(
      allContracts,
      0,
      blockReference
    );
    logger.info(`[TRANSACTIONS ${transactions.length.toLocaleString()}]`);
    const result = buildFullOwnersFromTransactions(
      blockReference,
      transactions
    );
    ownersDelta = result.ownersDelta;
    addresses = result.addresses;
    logger.info({
      ownersDelta: ownersDelta.length.toLocaleString(),
      addresses: addresses.size.toLocaleString()
    });
  } else {
    addresses = new Set<string>();
    logger.info(
      `[lastOwnersBlock ${lastOwnersBlock}] : [blockReference ${blockReference}] : [FETCHING TRANSACTIONS...]`
    );
    const transactions = await fetchTransactionsAfterBlock(
      allContracts,
      lastOwnersBlock,
      blockReference
    );
    for (const tx of transactions) {
      if (!ethTools.isNullOrDeadAddress(tx.from_address)) {
        addresses.add(tx.from_address.toLowerCase());
      }
      if (!ethTools.isNullOrDeadAddress(tx.to_address)) {
        addresses.add(tx.to_address.toLowerCase());
      }
    }
    logger.info({
      transactions: transactions.length.toLocaleString(),
      addresses: addresses.size.toLocaleString()
    });
    if (addresses.size === 0) {
      logger.info(`[NO CHANGES]`);
      return;
    }
    const existingOwners = await fetchAllNftOwners(
      undefined,
      Array.from(addresses)
    );
    const baseBalance = ownersToBalanceMap(existingOwners);
    ownersDelta = buildOwnersDeltaFromTransactions(
      blockReference,
      addresses,
      transactions,
      baseBalance
    );
    logger.info({ ownersDelta: ownersDelta.length.toLocaleString() });
  }

  if (addresses.size > 0) {
    await persistNftOwners(addresses, ownersDelta, reset);
    await consolidateNftOwners(addresses, reset);
    await setNftOwnersSyncBlock(blockReference);
  }
};

export async function consolidateNftOwners(
  addresses: Set<string>,
  reset?: boolean
) {
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
      )[0];

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

      consolidationAddresses.forEach((addr) => deleteDelta.add(addr));
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
