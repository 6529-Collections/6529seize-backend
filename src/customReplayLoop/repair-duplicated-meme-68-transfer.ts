import { EntityManager, Repository } from 'typeorm';
import { getDataSource } from '../db';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';
import { Transaction } from '../entities/ITransaction';
import { Logger } from '../logging';

const TRANSACTION_HASH =
  '0xfe14ce51f9ef4313f7700f03124ca79c7422e3a8a47b0998d8e9c1328d3f93db';
const TRANSACTION_BLOCK = 25624332;
const MEMES_CONTRACT = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const SENDER = '0x362ae71209f5640214ee0783b5da680505f8d562';
const RECIPIENT = '0xed3d302285c8830c3d4b6a01dfd9bfda7e2ea26c';
const TOKEN_ID = 68;
const INCORRECT_BALANCE = 2;
const CORRECT_BALANCE = 1;

const logger = Logger.get('CUSTOM_REPLAY_MEME_68_TDH_REPAIR');

type TokenValue = {
  readonly tokenId: number;
  readonly value: number;
};

type ExpectedRepairValues = {
  readonly transactionCount: number;
  readonly recipientOwnerBalance: number;
  readonly recipientConsolidatedBalance: number;
};

const NEEDS_REPAIR: ExpectedRepairValues = {
  transactionCount: INCORRECT_BALANCE,
  recipientOwnerBalance: INCORRECT_BALANCE,
  recipientConsolidatedBalance: INCORRECT_BALANCE
};

const REPAIRED: ExpectedRepairValues = {
  transactionCount: CORRECT_BALANCE,
  recipientOwnerBalance: CORRECT_BALANCE,
  recipientConsolidatedBalance: CORRECT_BALANCE
};

export type ProdTdhRepairSnapshot = {
  readonly transactions: TokenValue[];
  readonly senderOwners: TokenValue[];
  readonly recipientOwners: TokenValue[];
  readonly recipientConsolidatedOwners: TokenValue[];
};

export type ProdTdhRepairState = 'needs-repair' | 'already-repaired';

export type ProdTdhRepairResult =
  | 'DRY_RUN_VERIFIED'
  | 'REPAIRED'
  | 'ALREADY_REPAIRED';

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
  if (snapshot.senderOwners.length > 0) {
    throw new Error(
      `[SENDER OWNERS] Expected no positive owner rows, found ${snapshot.senderOwners.length}`
    );
  }
  assertSingleTokenValue(
    'TRANSACTION',
    snapshot.transactions,
    expected.transactionCount
  );
  assertSingleTokenValue(
    'RECIPIENT OWNER',
    snapshot.recipientOwners,
    expected.recipientOwnerBalance
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

async function findRecipientConsolidatedOwnersForUpdate(
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
  const recipientConsolidatedOwners =
    await findRecipientConsolidatedOwnersForUpdate(manager);

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
      token_count: INCORRECT_BALANCE
    },
    { token_count: CORRECT_BALANCE }
  );
  assertOneAffected('TRANSACTION', transactionUpdate.affected);

  const ownerUpdate = await manager.getRepository(NFTOwner).update(
    {
      wallet: RECIPIENT,
      contract: MEMES_CONTRACT,
      token_id: TOKEN_ID,
      balance: INCORRECT_BALANCE
    },
    { balance: CORRECT_BALANCE }
  );
  assertOneAffected('RECIPIENT OWNER', ownerUpdate.affected);

  const consolidatedOwnerUpdate = await manager
    .getRepository(ConsolidatedNFTOwner)
    .update(
      {
        consolidation_key: RECIPIENT,
        contract: MEMES_CONTRACT,
        token_id: TOKEN_ID,
        balance: INCORRECT_BALANCE
      },
      { balance: CORRECT_BALANCE }
    );
  assertOneAffected(
    'RECIPIENT CONSOLIDATED OWNER',
    consolidatedOwnerUpdate.affected
  );
}

export async function repairDuplicatedMeme68Transfer(
  apply = false
): Promise<ProdTdhRepairResult> {
  return getDataSource().transaction(async (manager) => {
    const before = await loadSnapshot(manager);
    const state = classifyProdTdhRepairSnapshot(before);

    if (state === 'already-repaired') {
      logger.info('[CUSTOM REPLAY] Meme 68 TDH data is already repaired');
      return 'ALREADY_REPAIRED';
    }

    if (!apply) {
      logger.info(
        `[CUSTOM REPLAY] [DRY RUN VERIFIED] Would update transaction, recipient owner, and recipient consolidated owner balances from ${INCORRECT_BALANCE} to ${CORRECT_BALANCE} for token ${TOKEN_ID}`
      );
      return 'DRY_RUN_VERIFIED';
    }

    logger.info(
      `[CUSTOM REPLAY] Repairing transaction ${TRANSACTION_HASH}, token ${TOKEN_ID}`
    );
    await applyRepair(manager);

    const after = await loadSnapshot(manager);
    const afterState = classifyProdTdhRepairSnapshot(after);
    if (afterState !== 'already-repaired') {
      throw new Error('[CUSTOM REPLAY] Post-repair verification failed');
    }

    logger.info('[CUSTOM REPLAY] Meme 68 TDH data repair verified');
    return 'REPAIRED';
  });
}
