import { EntityManager, In, Repository } from 'typeorm';
import { getDataSource } from '../db';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';
import { Transaction } from '../entities/ITransaction';
import { Logger } from '../logging';

const TRANSACTION_HASH =
  '0xc58c1104651207ae9e32e208da08901d3df87fd63435ae4c7b0005b81000a25b';
const MEMES_CONTRACT = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const SENDER = '0x2ee4c45af89774c76a8a73178c281089a8771a00';
const RECIPIENT = '0xbb78a151673fac1a0a2162abc7bee3a39b3767b5';
const TOKEN_IDS = [135, 254] as const;
const INCORRECT_BALANCE = 2;
const CORRECT_BALANCE = 1;

const logger = Logger.get('CUSTOM_REPLAY_TDH_DATA_REPAIR');

type TokenValue = {
  readonly tokenId: number;
  readonly value: number;
};

export type ProdTdhRepairSnapshot = {
  readonly transactions: TokenValue[];
  readonly recipientOwners: TokenValue[];
  readonly recipientConsolidatedOwners: TokenValue[];
  readonly senderOwners: TokenValue[];
};

export type ProdTdhRepairState = 'needs-repair' | 'already-repaired';

export type ProdTdhRepairResult =
  'DRY_RUN_VERIFIED' | 'REPAIRED' | 'ALREADY_REPAIRED';

function assertExpectedTokenValues(
  label: string,
  rows: TokenValue[],
  expectedValue: number
): void {
  if (rows.length !== TOKEN_IDS.length) {
    throw new Error(
      `[${label}] Expected ${TOKEN_IDS.length} rows, found ${rows.length}`
    );
  }

  for (const tokenId of TOKEN_IDS) {
    const matchingRows = rows.filter((row) => row.tokenId === tokenId);
    if (matchingRows.length !== 1) {
      throw new Error(
        `[${label}] Expected one row for token ${tokenId}, found ${matchingRows.length}`
      );
    }
    if (matchingRows[0].value !== expectedValue) {
      throw new Error(
        `[${label}] Expected token ${tokenId} value ${expectedValue}, found ${matchingRows[0].value}`
      );
    }
  }
}

function snapshotMatchesValue(
  snapshot: ProdTdhRepairSnapshot,
  expectedValue: number
): boolean {
  try {
    assertExpectedTokenValues(
      'TRANSACTIONS',
      snapshot.transactions,
      expectedValue
    );
    assertExpectedTokenValues(
      'RECIPIENT OWNERS',
      snapshot.recipientOwners,
      expectedValue
    );
    assertExpectedTokenValues(
      'RECIPIENT CONSOLIDATED OWNERS',
      snapshot.recipientConsolidatedOwners,
      expectedValue
    );
    return true;
  } catch {
    return false;
  }
}

export function classifyProdTdhRepairSnapshot(
  snapshot: ProdTdhRepairSnapshot
): ProdTdhRepairState {
  if (snapshot.senderOwners.length > 0) {
    throw new Error(
      `[SENDER OWNERS] Expected no positive owner rows, found ${snapshot.senderOwners.length}`
    );
  }

  if (snapshotMatchesValue(snapshot, CORRECT_BALANCE)) {
    return 'already-repaired';
  }

  if (snapshotMatchesValue(snapshot, INCORRECT_BALANCE)) {
    return 'needs-repair';
  }

  assertExpectedTokenValues(
    'TRANSACTIONS',
    snapshot.transactions,
    INCORRECT_BALANCE
  );
  assertExpectedTokenValues(
    'RECIPIENT OWNERS',
    snapshot.recipientOwners,
    INCORRECT_BALANCE
  );
  assertExpectedTokenValues(
    'RECIPIENT CONSOLIDATED OWNERS',
    snapshot.recipientConsolidatedOwners,
    INCORRECT_BALANCE
  );

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
    .andWhere('tx.from_address = :sender', { sender: SENDER })
    .andWhere('tx.to_address = :recipient', {
      recipient: RECIPIENT
    })
    .andWhere('tx.contract = :contract', {
      contract: MEMES_CONTRACT
    })
    .andWhere('tx.token_id IN (:...tokenIds)', {
      tokenIds: TOKEN_IDS
    })
    .orderBy('tx.token_id', 'ASC')
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
    .andWhere('owner.token_id IN (:...tokenIds)', { tokenIds: TOKEN_IDS })
    .orderBy('owner.token_id', 'ASC')
    .getMany();
}

async function findConsolidatedOwnersForUpdate(
  manager: EntityManager
): Promise<ConsolidatedNFTOwner[]> {
  return manager
    .getRepository(ConsolidatedNFTOwner)
    .createQueryBuilder('owner')
    .setLock('pessimistic_write')
    .where('owner.consolidation_key = :consolidationKey', {
      consolidationKey: RECIPIENT
    })
    .andWhere('owner.contract = :contract', { contract: MEMES_CONTRACT })
    .andWhere('owner.token_id IN (:...tokenIds)', { tokenIds: TOKEN_IDS })
    .orderBy('owner.token_id', 'ASC')
    .getMany();
}

async function loadSnapshot(
  manager: EntityManager
): Promise<ProdTdhRepairSnapshot> {
  const transactions = await findTransactionsForUpdate(manager);
  const ownerRepository = manager.getRepository(NFTOwner);
  const recipientOwners = await findOwnersForUpdate(ownerRepository, RECIPIENT);
  const senderOwners = await findOwnersForUpdate(ownerRepository, SENDER);
  const recipientConsolidatedOwners =
    await findConsolidatedOwnersForUpdate(manager);

  return {
    transactions: toTokenValues(
      transactions,
      (row) => row.token_id,
      (row) => row.token_count
    ),
    recipientOwners: toTokenValues(
      recipientOwners,
      (row) => row.token_id,
      (row) => row.balance
    ),
    recipientConsolidatedOwners: toTokenValues(
      recipientConsolidatedOwners,
      (row) => row.token_id,
      (row) => row.balance
    ),
    senderOwners: toTokenValues(
      senderOwners,
      (row) => row.token_id,
      (row) => row.balance
    )
  };
}

function assertAffectedRows(
  label: string,
  affected: number | null | undefined
): void {
  if (affected !== TOKEN_IDS.length) {
    throw new Error(
      `[${label}] Expected to update ${TOKEN_IDS.length} rows, updated ${
        affected ?? 0
      }`
    );
  }
}

async function applyRepair(manager: EntityManager): Promise<void> {
  const transactionUpdate = await manager.getRepository(Transaction).update(
    {
      transaction: TRANSACTION_HASH,
      from_address: SENDER,
      to_address: RECIPIENT,
      contract: MEMES_CONTRACT,
      token_id: In([...TOKEN_IDS]),
      token_count: INCORRECT_BALANCE
    },
    { token_count: CORRECT_BALANCE }
  );
  assertAffectedRows('TRANSACTIONS', transactionUpdate.affected);

  const ownerUpdate = await manager.getRepository(NFTOwner).update(
    {
      wallet: RECIPIENT,
      contract: MEMES_CONTRACT,
      token_id: In([...TOKEN_IDS]),
      balance: INCORRECT_BALANCE
    },
    { balance: CORRECT_BALANCE }
  );
  assertAffectedRows('RECIPIENT OWNERS', ownerUpdate.affected);

  const consolidatedOwnerUpdate = await manager
    .getRepository(ConsolidatedNFTOwner)
    .update(
      {
        consolidation_key: RECIPIENT,
        contract: MEMES_CONTRACT,
        token_id: In([...TOKEN_IDS]),
        balance: INCORRECT_BALANCE
      },
      { balance: CORRECT_BALANCE }
    );
  assertAffectedRows(
    'RECIPIENT CONSOLIDATED OWNERS',
    consolidatedOwnerUpdate.affected
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
        `[CUSTOM REPLAY] [DRY RUN VERIFIED] Would update transaction, owner, and consolidated owner balances from ${INCORRECT_BALANCE} to ${CORRECT_BALANCE} for tokens ${TOKEN_IDS.join(
          ','
        )}`
      );
      return 'DRY_RUN_VERIFIED';
    }

    logger.info(
      `[CUSTOM REPLAY] Repairing transaction ${TRANSACTION_HASH}, tokens ${TOKEN_IDS.join(
        ','
      )}`
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
