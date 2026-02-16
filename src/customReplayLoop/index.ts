import { TRANSACTIONS_TABLE } from '@/constants';
import { withRetry } from '@/customReplayLoop/retry';
import { findTransactionsByHash } from '@/db';
import { Transaction } from '@/entities/ITransaction';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import { sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import { findTransactionValues } from '@/transaction_values';
import { transactionsDb } from '@/transactions/transactions.discovery.db';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

const PROGRESS_TABLE = 'custom_replay_progress';
const PROGRESS_ID = 'default';
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_BATCH_RETRY_ATTEMPTS = 5;
const DEFAULT_CHECKPOINT_RETRY_ATTEMPTS = 5;
const USE_6529_RPC = true;
const REPLAY_STATUS_RUNNING = 'RUNNING';
const REPLAY_STATUS_COMPLETE = 'COMPLETE';

type ReplayStatus =
  | typeof REPLAY_STATUS_RUNNING
  | typeof REPLAY_STATUS_COMPLETE;

type ReplayCheckpoint = {
  last_block: number;
  last_transaction: string;
  processed_hashes: number;
  status: ReplayStatus;
};

type ReplayHash = {
  transaction: string;
  block: number;
};

type ReplayBatchStats = {
  requestedHashes: number;
  hashesWithRows: number;
  uniqueHashesFetched: number;
  rowsFetched: number;
  rowsReplayed: number;
  fetchRowsMs: number;
  resolveValuesMs: number;
  upsertMs: number;
};

type ReplayCheckpointState = {
  checkpoint: ReplayCheckpoint;
  isNew: boolean;
};

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await replayAllInBatches();
    },
    { logger, entities: [Transaction] }
  );
});

async function replayAllInBatches() {
  const replayStart = Time.now();
  const batchSize = DEFAULT_BATCH_SIZE;
  const batchRetryAttempts = DEFAULT_BATCH_RETRY_ATTEMPTS;
  const checkpointRetryAttempts = DEFAULT_CHECKPOINT_RETRY_ATTEMPTS;
  logger.info(
    `[CUSTOM REPLAY] [MODE=ALL] [BATCH_SIZE=${batchSize}] [BATCH_RETRIES=${batchRetryAttempts}] [CHECKPOINT_RETRIES=${checkpointRetryAttempts}]`
  );

  await ensureProgressTable();
  logger.info(`[CUSTOM REPLAY] [PROGRESS_TABLE_READY=${PROGRESS_TABLE}]`);

  const checkpointState = await getOrCreateCheckpoint();
  let checkpoint = checkpointState.checkpoint;
  if (checkpoint.status === REPLAY_STATUS_COMPLETE) {
    logger.info(
      `[CUSTOM REPLAY] [STATE=COMPLETE] [ACTION=EXIT] [CHECKPOINT=${formatCheckpoint(checkpoint)}] [PROCESSED_HASHES=${checkpoint.processed_hashes}]`
    );
    return;
  }
  const checkpointDisplay = formatCheckpoint(checkpoint);
  logger.info(
    `[CUSTOM REPLAY] [DIRECTION=DESC] [CHECKPOINT=${checkpointDisplay}] [PROCESSED_HASHES=${checkpoint.processed_hashes}] [STATE=${checkpointState.isNew ? 'NEW' : 'RESUME'}]`
  );

  const totalHashes = await countDistinctTransactionHashes();
  const remaining = Math.max(totalHashes - checkpoint.processed_hashes, 0);
  logger.info(
    `[CUSTOM REPLAY] [TOTAL_HASHES=${totalHashes}] [REMAINING=${remaining}]`
  );

  let batchIndex = 0;
  while (true) {
    const batchHashes = await fetchNextBatchHashes(checkpoint, batchSize);
    if (!batchHashes.length) {
      checkpoint = {
        ...checkpoint,
        status: REPLAY_STATUS_COMPLETE
      };
      await withRetry(() => saveCheckpoint(checkpoint), {
        attempts: checkpointRetryAttempts,
        onRetry: (err, attempt) => {
          const errorCode = err?.code ?? '-';
          const errorMessage = sanitizeErrorMessage(err);
          logger.warn(
            `[CUSTOM REPLAY] [COMPLETE_CHECKPOINT_RETRY] [RETRY=${attempt}/${checkpointRetryAttempts - 1}] [CODE=${errorCode}] [ERROR=${errorMessage}]`
          );
        }
      });
      const duration = replayStart.diffFromNow().formatAsDuration();
      logger.info(
        `[CUSTOM REPLAY] [COMPLETE] [DIRECTION=DESC] [PROCESSED=${checkpoint.processed_hashes}/${totalHashes}] [DURATION=${duration}] [STATUS=${checkpoint.status}] [CHECKPOINT=${formatCheckpoint(checkpoint)}]`
      );
      return;
    }

    batchIndex++;
    const batchStart = Time.now();
    const first = batchHashes[0];
    const last = batchHashes[batchHashes.length - 1];
    logger.info(
      `[CUSTOM REPLAY] [BATCH=${batchIndex}] [DIRECTION=DESC] [HASHES=${batchHashes.length}] [FROM=${first.block}/${first.transaction}] [TO=${last.block}/${last.transaction}]`
    );

    const batchStats = await withRetry(() => replayBatch(batchHashes), {
      attempts: batchRetryAttempts,
      onRetry: (err, attempt) => {
        const errorCode = err?.code ?? '-';
        const errorMessage = sanitizeErrorMessage(err);
        logger.warn(
          `[CUSTOM REPLAY] [BATCH_RETRY] [BATCH=${batchIndex}] [RETRY=${attempt}/${batchRetryAttempts - 1}] [CODE=${errorCode}] [ERROR=${errorMessage}]`
        );
      }
    });

    const newCheckpoint: ReplayCheckpoint = {
      last_block: last.block,
      last_transaction: last.transaction,
      processed_hashes: checkpoint.processed_hashes + batchHashes.length,
      status: REPLAY_STATUS_RUNNING
    };
    const checkpointSaveStart = Time.now();
    await withRetry(() => saveCheckpoint(newCheckpoint), {
      attempts: checkpointRetryAttempts,
      onRetry: (err, attempt) => {
        const errorCode = err?.code ?? '-';
        const errorMessage = sanitizeErrorMessage(err);
        logger.warn(
          `[CUSTOM REPLAY] [CHECKPOINT_RETRY] [BATCH=${batchIndex}] [RETRY=${attempt}/${checkpointRetryAttempts - 1}] [CODE=${errorCode}] [ERROR=${errorMessage}]`
        );
      }
    });
    const checkpointSaveMs = checkpointSaveStart.diffFromNow().toMillis();
    checkpoint = newCheckpoint;

    const batchDuration = batchStart.diffFromNow().formatAsDuration();
    const replayedPercentage =
      totalHashes > 0
        ? ((checkpoint.processed_hashes / totalHashes) * 100).toFixed(2)
        : '100.00';
    const hashesRemaining = Math.max(
      totalHashes - checkpoint.processed_hashes,
      0
    );
    const checkpointNow = formatCheckpoint(checkpoint);

    logger.info(
      `[CUSTOM REPLAY] [BATCH_DONE=${batchIndex}] [DURATION=${batchDuration}] [STAGES=fetch:${formatDurationMs(batchStats.fetchRowsMs)}|resolve:${formatDurationMs(batchStats.resolveValuesMs)}|upsert:${formatDurationMs(batchStats.upsertMs)}|checkpoint:${formatDurationMs(checkpointSaveMs)}] [HASHES_WITH_ROWS=${batchStats.hashesWithRows}/${batchStats.requestedHashes}] [UNIQUE_HASHES_FETCHED=${batchStats.uniqueHashesFetched}] [ROWS_FETCHED=${batchStats.rowsFetched}] [ROWS_REPLAYED=${batchStats.rowsReplayed}] [PROCESSED=${checkpoint.processed_hashes}/${totalHashes}] [REMAINING=${hashesRemaining}] [PCT=${replayedPercentage}%] [CHECKPOINT=${checkpointNow}]`
    );
  }
}

function sanitizeErrorMessage(err: any) {
  const raw = err?.message ? String(err.message) : String(err ?? 'unknown');
  return raw.replace(/\s+/g, ' ').slice(0, 300);
}

function formatDurationMs(ms: number) {
  return Time.millis(Math.max(0, Math.floor(ms))).formatAsDuration();
}

function formatCheckpoint(checkpoint: ReplayCheckpoint) {
  return `${checkpoint.last_block}/${checkpoint.last_transaction || '-'}`;
}

async function getDescendingStartCheckpoint(): Promise<ReplayCheckpoint> {
  const maxBlockResult = await sqlExecutor.execute<{
    max_block: number | null;
  }>(`SELECT MAX(block) as max_block FROM ${TRANSACTIONS_TABLE}`);
  const currentMaxBlock = Number(maxBlockResult[0]?.max_block ?? 0);
  const startBlock = Number.isFinite(currentMaxBlock) ? currentMaxBlock + 1 : 1;
  return {
    last_block: startBlock,
    last_transaction: '',
    processed_hashes: 0,
    status: REPLAY_STATUS_RUNNING
  };
}

async function ensureProgressTable() {
  await sqlExecutor.execute(`
    CREATE TABLE IF NOT EXISTS ${PROGRESS_TABLE} (
      id varchar(64) NOT NULL,
      last_block int NOT NULL DEFAULT 0,
      last_transaction varchar(100) NOT NULL DEFAULT '',
      processed_hashes bigint NOT NULL DEFAULT 0,
      status varchar(16) NOT NULL DEFAULT '${REPLAY_STATUS_RUNNING}',
      created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  try {
    await sqlExecutor.execute(
      `ALTER TABLE ${PROGRESS_TABLE}
       ADD COLUMN status varchar(16) NOT NULL DEFAULT '${REPLAY_STATUS_RUNNING}'`
    );
  } catch (e: any) {
    const code = e?.code ?? '';
    const message = String(e?.message ?? '');
    const duplicateColumn =
      code === 'ER_DUP_FIELDNAME' || message.includes('Duplicate column name');
    if (!duplicateColumn) {
      throw e;
    }
  }
}

async function getOrCreateCheckpoint(): Promise<ReplayCheckpointState> {
  const descendingStartCheckpoint = await getDescendingStartCheckpoint();
  const existing = await sqlExecutor.execute<ReplayCheckpoint>(
    `SELECT last_block, last_transaction, processed_hashes, status
      FROM ${PROGRESS_TABLE}
      WHERE id = :id
      LIMIT 1`,
    { id: PROGRESS_ID }
  );

  if (existing.length) {
    const existingCheckpoint: ReplayCheckpoint = {
      last_block: Number(existing[0].last_block ?? 0),
      last_transaction: existing[0].last_transaction ?? '',
      processed_hashes: Number(existing[0].processed_hashes ?? 0),
      status: normalizeReplayStatus(existing[0].status)
    };

    // Migrate legacy empty checkpoints (ASC start or old synthetic DESC start)
    // to current dynamic DESC start derived from DB max(block).
    if (
      existingCheckpoint.processed_hashes === 0 &&
      (existingCheckpoint.last_block === 0 ||
        existingCheckpoint.last_block > descendingStartCheckpoint.last_block)
    ) {
      await saveCheckpoint(descendingStartCheckpoint);
      return { checkpoint: descendingStartCheckpoint, isNew: true };
    }

    return {
      checkpoint: existingCheckpoint,
      isNew: false
    };
  }

  await saveCheckpoint(descendingStartCheckpoint);
  return { checkpoint: descendingStartCheckpoint, isNew: true };
}

async function saveCheckpoint(checkpoint: ReplayCheckpoint) {
  await sqlExecutor.execute(
    `INSERT INTO ${PROGRESS_TABLE} (
      id,
      last_block,
      last_transaction,
      processed_hashes,
      status
    ) VALUES (
      :id,
      :lastBlock,
      :lastTransaction,
      :processedHashes,
      :status
    ) ON DUPLICATE KEY UPDATE
      last_block = :lastBlock,
      last_transaction = :lastTransaction,
      processed_hashes = :processedHashes,
      status = :status`,
    {
      id: PROGRESS_ID,
      lastBlock: checkpoint.last_block,
      lastTransaction: checkpoint.last_transaction,
      processedHashes: checkpoint.processed_hashes,
      status: checkpoint.status
    }
  );
}

function normalizeReplayStatus(status: string | undefined): ReplayStatus {
  return status === REPLAY_STATUS_COMPLETE
    ? REPLAY_STATUS_COMPLETE
    : REPLAY_STATUS_RUNNING;
}

async function countDistinctTransactionHashes() {
  const result = await sqlExecutor.execute<{ count: number }>(
    `SELECT COUNT(*) as count
      FROM (
        SELECT transaction
        FROM ${TRANSACTIONS_TABLE}
        GROUP BY transaction
      ) txs`
  );
  return Number(result[0]?.count ?? 0);
}

async function fetchNextBatchHashes(
  checkpoint: ReplayCheckpoint,
  batchSize: number
): Promise<ReplayHash[]> {
  return sqlExecutor.execute<ReplayHash>(
    `SELECT
      tx.transaction as transaction,
      tx.max_block as block
    FROM (
      SELECT
        transaction,
        MAX(block) as max_block
      FROM ${TRANSACTIONS_TABLE}
      GROUP BY transaction
    ) tx
    WHERE
      tx.max_block < :lastBlock
      OR (
        tx.max_block = :lastBlock
        AND tx.transaction < :lastTransaction
      )
    ORDER BY tx.max_block DESC, tx.transaction DESC
    LIMIT :batchSize`,
    {
      lastBlock: checkpoint.last_block,
      lastTransaction: checkpoint.last_transaction,
      batchSize
    }
  );
}

async function replayBatch(
  batchHashes: ReplayHash[]
): Promise<ReplayBatchStats> {
  const hashes = batchHashes.map((it) => it.transaction);
  const fetchRowsStart = Time.now();
  const rows = await findTransactionsByHash(TRANSACTIONS_TABLE, hashes);
  const fetchRowsMs = fetchRowsStart.diffFromNow().toMillis();
  const rowHashes = new Set(rows.map((row) => row.transaction.toLowerCase()));
  const hashesWithRows = hashes.filter((hash) =>
    rowHashes.has(hash.toLowerCase())
  ).length;

  const resolveValuesStart = Time.now();
  const replayedRows = rows.length
    ? await findTransactionValues(rows, undefined, USE_6529_RPC)
    : [];
  const resolveValuesMs = resolveValuesStart.diffFromNow().toMillis();

  let upsertMs = 0;
  if (replayedRows.length) {
    const upsertStart = Time.now();
    await transactionsDb.batchUpsertTransactions(replayedRows);
    upsertMs = upsertStart.diffFromNow().toMillis();
  }

  return {
    requestedHashes: batchHashes.length,
    hashesWithRows,
    uniqueHashesFetched: rowHashes.size,
    rowsFetched: rows.length,
    rowsReplayed: replayedRows.length,
    fetchRowsMs,
    resolveValuesMs,
    upsertMs
  };
}
