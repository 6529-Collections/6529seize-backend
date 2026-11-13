import {
  transferReconciliationDb,
  transferWallets
} from '@/transactions/transfer-reconciliation.db';
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
  MEMES_CONTRACT,
  NULL_ADDRESS
} from '@/constants';
import { fetchConsolidationGroupsForAddresses } from '../db';

function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}

function deltaKey(wallet: string, contract: string, tokenId: number): string {
  return `${wallet.toLowerCase()}-${contract.toLowerCase()}-${tokenId}`;
}

function parseDeltaKey(
  key: string
): { wallet: string; contract: string; token_id: number } | null {
  const parts = key.split('-');
  if (parts.length !== 3) return null;
  const tokenId = Number.parseInt(parts[2], 10);
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
    const key = `${tx.transaction}-${normalizeAddress(tx.from_address)}-${normalizeAddress(tx.to_address)}-${tx.contract}-${tx.token_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildBalanceMapFromTransactions(
  transactions: Transaction[]
): Map<string, number> {
  const deduped = dedupeTransactionsByTransfer(transactions);
  const zeroAddr = NULL_ADDRESS.toLowerCase();
  const balance = new Map<string, number>();
  for (const tx of deduped) {
    const contract = tx.contract.toLowerCase();
    const tokenId = Number(tx.token_id);
    const count = tx.token_count == null ? 0 : Number(tx.token_count);
    const fromAddr = normalizeAddress(tx.from_address);
    const toAddr = normalizeAddress(tx.to_address);
    const fromKey = deltaKey(fromAddr, contract, tokenId);
    const toKey = deltaKey(toAddr, contract, tokenId);
    if (fromAddr !== zeroAddr) {
      balance.set(fromKey, (balance.get(fromKey) ?? 0) - count);
    }
    balance.set(toKey, (balance.get(toKey) ?? 0) + count);
  }
  return balance;
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
    if (!parsed) continue;
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

  const pending = await transferReconciliationDb.pending('owners');
  const blockReference = await transferReconciliationDb.maxBlock();
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
    const transactions = await transferReconciliationDb.changes(
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
    addresses = new Set(transferWallets(transactions).map(normalizeAddress));
    pending.forEach((row) => addresses.add(row.wallet));
    logger.info({
      ownersDelta: ownersDelta.length.toLocaleString(),
      addresses: addresses.size.toLocaleString()
    });
  } else {
    addresses = new Set<string>();
    logger.info(
      `[lastOwnersBlock ${lastOwnersBlock}] : [blockReference ${blockReference}] : [FETCHING TRANSACTIONS...]`
    );
    const transactions = await transferReconciliationDb.changes(
      allContracts,
      lastOwnersBlock,
      blockReference
    );
    for (const wallet of transferWallets(transactions))
      addresses.add(normalizeAddress(wallet));
    pending.forEach((row) => addresses.add(row.wallet));
    if (addresses.size === 0) {
      logger.info(`[NO CHANGES]`);
      return;
    }
    const history = await transferReconciliationDb.history(
      allContracts,
      Array.from(addresses),
      blockReference
    );
    ownersDelta = buildFullOwnersFromTransactions(
      blockReference,
      history
    ).ownersDelta.filter((owner) => addresses.has(owner.wallet));
    logger.info({ ownersDelta: ownersDelta.length.toLocaleString() });
  }

  if (addresses.size > 0) {
    if ((await getNftOwnersSyncBlock()) !== syncBlock) {
      throw new Error('NFT owner source moved before reconciliation');
    }
    await persistNftOwners(addresses, ownersDelta, reset);
    await consolidateNftOwners(addresses, reset);
    await setNftOwnersSyncBlock(blockReference);
    await transferReconciliationDb.publishBalances(Array.from(addresses));
    await transferReconciliationDb.acknowledge(pending);
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

  // one batched lookup for all addresses, then one owners fetch per unique
  // consolidation instead of one per member address
  const consolidationGroups = await fetchConsolidationGroupsForAddresses(
    Array.from(addresses)
  );

  await Promise.all(
    Array.from(consolidationGroups.entries()).map(
      async ([consolidationKey, consolidationAddresses]) => {
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
      }
    )
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
