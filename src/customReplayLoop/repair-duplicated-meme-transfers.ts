import { EntityManager, Repository } from 'typeorm';
import { getDataSource } from '../db';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';
import { Transaction } from '../entities/ITransaction';
import { Logger } from '../logging';

const TRANSACTION_HASH =
  '0xd6af5074fcdb210a5cfc2e85ad9f512e684271cc9158454cbb123d134efef30f';
const TRANSACTION_BLOCK = 25626547;
const MEMES_CONTRACT = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const SENDER = '0x1115e7bed26542bf247a7f800a9f48d530c3f955';
const RECIPIENT = '0xd0b53c871a4c2ab5db77ad752aa950f781021982';
const TOKEN_ID = 473;
const SENDER_CONSOLIDATION_KEY =
  '0x1115e7bed26542bf247a7f800a9f48d530c3f955-0x30b7b41e299f90ae78a11b764ad2804ab2bf272b-0xe330b0ab6d18e3f523890403a9df284feb4ba2b8';
const RECIPIENT_CONSOLIDATION_KEY =
  '0x4220132c9df1ab7bd2913f0fd03297c90e7cc6fe-0x7b5af6790381f932abae790e8b0d0ff50e287f8e-0xd0b53c871a4c2ab5db77ad752aa950f781021982';

const logger = Logger.get('CUSTOM_REPLAY_TDH_DATA_REPAIR');

type TokenValue = {
  readonly tokenId: number;
  readonly value: number;
};

type ExpectedRepairValues = {
  readonly transactionCount: number;
  readonly senderOwnerBalance: number;
  readonly recipientOwnerBalance: number;
  readonly senderConsolidatedBalance: number;
  readonly recipientConsolidatedBalance: number;
};

const NEEDS_REPAIR: ExpectedRepairValues = {
  transactionCount: 2,
  senderOwnerBalance: 1,
  recipientOwnerBalance: 2,
  senderConsolidatedBalance: 33,
  recipientConsolidatedBalance: 2
};

const REPAIRED: ExpectedRepairValues = {
  transactionCount: 1,
  senderOwnerBalance: 2,
  recipientOwnerBalance: 1,
  senderConsolidatedBalance: 34,
  recipientConsolidatedBalance: 1
};

export type ProdTdhRepairSnapshot = {
  readonly transactions: TokenValue[];
  readonly senderOwners: TokenValue[];
  readonly recipientOwners: TokenValue[];
  readonly senderConsolidatedOwners: TokenValue[];
  readonly recipientConsolidatedOwners: TokenValue[];
};

export type ProdTdhRepairState = 'needs-repair' | 'already-repaired';

export type ProdTdhRepairResult =
  'DRY_RUN_VERIFIED' | 'REPAIRED' | 'ALREADY_REPAIRED';

function assertSingleTokenValue(
  label: string,
  rows: TokenValue[],
  expectedValue: number
): void {
  if (rows.length !== 1) {
    throw new Error(`[${label}] Expected 1 row, found ${rows.length}`);
  }
  if (rows[0].tokenId !== TOKEN_ID) {
    throw new Error(
      `[${label}] Expected token ${TOKEN_ID}, found ${rows[0].tokenId}`
    );
  }
  if (rows[0].value !== expectedValue) {
    throw new Error(
      `[${label}] Expected token ${TOKEN_ID} value ${expectedValue}, found ${rows[0].value}`
    );
  }
}

function assertSnapshotValues(
  snapshot: ProdTdhRepairSnapshot,
  expected: ExpectedRepairValues
): void {
  assertSingleTokenValue(
    'TRANSACTION',
    snapshot.transactions,
    expected.transactionCount
  );
  assertSingleTokenValue(
    'SENDER OWNER',
    snapshot.senderOwners,
    expected.senderOwnerBalance
  );
  assertSingleTokenValue(
    'RECIPIENT OWNER',
    snapshot.recipientOwners,
    expected.recipientOwnerBalance
  );
  assertSingleTokenValue(
    'SENDER CONSOLIDATED OWNER',
    snapshot.senderConsolidatedOwners,
    expected.senderConsolidatedBalance
  );
  assertSingleTokenValue(
    'RECIPIENT CONSOLIDATED OWNER',
    snapshot.recipientConsolidatedOwners,
    expected.recipientConsolidatedBalance
  );
}

function snapshotMatches(
  snapshot: ProdTdhRepairSnapshot,
  expected: ExpectedRepairValues
): boolean {
  try {
    assertSnapshotValues(snapshot, expected);
    return true;
  } catch {
    return false;
  }
}

export function classifyProdTdhRepairSnapshot(
  snapshot: ProdTdhRepairSnapshot
): ProdTdhRepairState {
  if (snapshotMatches(snapshot, REPAIRED)) {
    return 'already-repaired';
  }
  if (snapshotMatches(snapshot, NEEDS_REPAIR)) {
    return 'needs-repair';
  }

  assertSnapshotValues(snapshot, NEEDS_REPAIR);
  throw new Error('[CUSTOM REPLAY] Unexpected repair state');
}

function toTokenValues<T>(
  rows: T[],
  tokenId: (row: T) => number,
  value: (row: T) => number
): TokenValue[] {
  return rows.map((row) => ({
    tokenId: Number(tokenId(row)),
    value: Number(value(row))
  }));
}

async function findTransactionsForUpdate(
  manager: EntityManager
): Promise<Transaction[]> {
  return manager
    .getRepository(Transaction)
    .createQueryBuilder('tx')
    .setLock('pessimistic_write')
    .where('tx.transaction = :transactionHash', {
      transactionHash: TRANSACTION_HASH
    })
    .andWhere('tx.block = :block', { block: TRANSACTION_BLOCK })
    .andWhere('tx.from_address = :sender', { sender: SENDER })
    .andWhere('tx.to_address = :recipient', { recipient: RECIPIENT })
    .andWhere('tx.contract = :contract', { contract: MEMES_CONTRACT })
    .andWhere('tx.token_id = :tokenId', { tokenId: TOKEN_ID })
    .getMany();
}

async function findOwnersForUpdate(
  repository: Repository<NFTOwner>,
  wallet: string
): Promise<NFTOwner[]> {
  return repository
    .createQueryBuilder('owner')
    .setLock('pessimistic_write')
    .where('owner.wallet = :wallet', { wallet })
    .andWhere('owner.contract = :contract', { contract: MEMES_CONTRACT })
    .andWhere('owner.token_id = :tokenId', { tokenId: TOKEN_ID })
    .getMany();
}

async function findConsolidatedOwnersForUpdate(
  manager: EntityManager,
  consolidationKey: string
): Promise<ConsolidatedNFTOwner[]> {
  return manager
    .getRepository(ConsolidatedNFTOwner)
    .createQueryBuilder('owner')
    .setLock('pessimistic_write')
    .where('owner.consolidation_key = :consolidationKey', {
      consolidationKey
    })
    .andWhere('owner.contract = :contract', { contract: MEMES_CONTRACT })
    .andWhere('owner.token_id = :tokenId', { tokenId: TOKEN_ID })
    .getMany();
}

async function loadSnapshot(
  manager: EntityManager
): Promise<ProdTdhRepairSnapshot> {
  const ownerRepository = manager.getRepository(NFTOwner);
  const transactions = await findTransactionsForUpdate(manager);
  const senderOwners = await findOwnersForUpdate(ownerRepository, SENDER);
  const recipientOwners = await findOwnersForUpdate(ownerRepository, RECIPIENT);
  const senderConsolidatedOwners = await findConsolidatedOwnersForUpdate(
    manager,
    SENDER_CONSOLIDATION_KEY
  );
  const recipientConsolidatedOwners = await findConsolidatedOwnersForUpdate(
    manager,
    RECIPIENT_CONSOLIDATION_KEY
  );

  return {
    transactions: toTokenValues(
      transactions,
      (row) => row.token_id,
      (row) => row.token_count
    ),
    senderOwners: toTokenValues(
      senderOwners,
      (row) => row.token_id,
      (row) => row.balance
    ),
    recipientOwners: toTokenValues(
      recipientOwners,
      (row) => row.token_id,
      (row) => row.balance
    ),
    senderConsolidatedOwners: toTokenValues(
      senderConsolidatedOwners,
      (row) => row.token_id,
      (row) => row.balance
    ),
    recipientConsolidatedOwners: toTokenValues(
      recipientConsolidatedOwners,
      (row) => row.token_id,
      (row) => row.balance
    )
  };
}

function assertOneAffected(
  label: string,
  affected: number | null | undefined
): void {
  if (affected !== 1) {
    throw new Error(
      `[${label}] Expected to update 1 row, updated ${affected ?? 0}`
    );
  }
}

async function applyRepair(manager: EntityManager): Promise<void> {
  const transactionUpdate = await manager.getRepository(Transaction).update(
    {
      transaction: TRANSACTION_HASH,
      block: TRANSACTION_BLOCK,
      from_address: SENDER,
      to_address: RECIPIENT,
      contract: MEMES_CONTRACT,
      token_id: TOKEN_ID,
      token_count: NEEDS_REPAIR.transactionCount
    },
    { token_count: REPAIRED.transactionCount }
  );
  assertOneAffected('TRANSACTION', transactionUpdate.affected);

  const ownerRepository = manager.getRepository(NFTOwner);
  const senderOwnerUpdate = await ownerRepository.update(
    {
      wallet: SENDER,
      contract: MEMES_CONTRACT,
      token_id: TOKEN_ID,
      balance: NEEDS_REPAIR.senderOwnerBalance
    },
    { balance: REPAIRED.senderOwnerBalance }
  );
  assertOneAffected('SENDER OWNER', senderOwnerUpdate.affected);

  const recipientOwnerUpdate = await ownerRepository.update(
    {
      wallet: RECIPIENT,
      contract: MEMES_CONTRACT,
      token_id: TOKEN_ID,
      balance: NEEDS_REPAIR.recipientOwnerBalance
    },
    { balance: REPAIRED.recipientOwnerBalance }
  );
  assertOneAffected('RECIPIENT OWNER', recipientOwnerUpdate.affected);

  const consolidatedOwnerRepository =
    manager.getRepository(ConsolidatedNFTOwner);
  const senderConsolidatedOwnerUpdate =
    await consolidatedOwnerRepository.update(
      {
        consolidation_key: SENDER_CONSOLIDATION_KEY,
        contract: MEMES_CONTRACT,
        token_id: TOKEN_ID,
        balance: NEEDS_REPAIR.senderConsolidatedBalance
      },
      { balance: REPAIRED.senderConsolidatedBalance }
    );
  assertOneAffected(
    'SENDER CONSOLIDATED OWNER',
    senderConsolidatedOwnerUpdate.affected
  );

  const recipientConsolidatedOwnerUpdate =
    await consolidatedOwnerRepository.update(
      {
        consolidation_key: RECIPIENT_CONSOLIDATION_KEY,
        contract: MEMES_CONTRACT,
        token_id: TOKEN_ID,
        balance: NEEDS_REPAIR.recipientConsolidatedBalance
      },
      { balance: REPAIRED.recipientConsolidatedBalance }
    );
  assertOneAffected(
    'RECIPIENT CONSOLIDATED OWNER',
    recipientConsolidatedOwnerUpdate.affected
  );
}

export async function repairDuplicatedMemeTransfers(
  apply = false
): Promise<ProdTdhRepairResult> {
  return getDataSource().transaction(async (manager) => {
    const before = await loadSnapshot(manager);
    const state = classifyProdTdhRepairSnapshot(before);

    if (state === 'already-repaired') {
      logger.info('[CUSTOM REPLAY] Production TDH data is already repaired');
      return 'ALREADY_REPAIRED';
    }

    if (!apply) {
      logger.info(
        `[CUSTOM REPLAY] [DRY RUN VERIFIED] Would repair Meme ${TOKEN_ID} transaction count, sender and recipient owner balances, and both consolidated-owner balances`
      );
      return 'DRY_RUN_VERIFIED';
    }

    logger.info(
      `[CUSTOM REPLAY] Repairing transaction ${TRANSACTION_HASH}, Meme ${TOKEN_ID}`
    );
    await applyRepair(manager);

    const after = await loadSnapshot(manager);
    const afterState = classifyProdTdhRepairSnapshot(after);
    if (afterState !== 'already-repaired') {
      throw new Error('[CUSTOM REPLAY] Post-repair verification failed');
    }

    logger.info('[CUSTOM REPLAY] Production TDH data repair verified');
    return 'REPAIRED';
  });
}
