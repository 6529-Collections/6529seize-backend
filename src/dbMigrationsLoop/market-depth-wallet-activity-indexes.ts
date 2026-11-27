import type { DataSource, QueryRunner } from 'typeorm';
import { MARKET_DEPTH_EVENTS_TABLE } from '@/constants';
import { getDataSource } from '@/db';
import {
  MARKET_DEPTH_MAKER_ACTIVITY_INDEX,
  MARKET_DEPTH_TAKER_ACTIVITY_INDEX
} from '@/entities/IMarketDepth';

export const MARKET_DEPTH_WALLET_ACTIVITY_INDEXES_SCOPE =
  'market-depth-wallet-activity-indexes';

const INDEXES = [
  MARKET_DEPTH_MAKER_ACTIVITY_INDEX,
  MARKET_DEPTH_TAKER_ACTIVITY_INDEX
];

interface IndexColumn {
  index_name: string;
  column_name: string;
  non_unique: number | string;
  sub_part: number | null;
  index_type: string;
  is_visible: string;
  collation: string;
}

async function pendingIndexChanges(runner: QueryRunner): Promise<string[]> {
  const existing: IndexColumn[] = await runner.query(
    `SELECT index_name AS index_name, column_name AS column_name,
            non_unique AS non_unique, sub_part AS sub_part,
            index_type AS index_type, is_visible AS is_visible,
            collation AS collation
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name IN (?, ?)
     ORDER BY seq_in_index`,
    [MARKET_DEPTH_EVENTS_TABLE, ...INDEXES.map(({ name }) => name)]
  );
  return INDEXES.flatMap(({ name, columns }) => {
    const current = existing.filter((column) => column.index_name === name);
    if (!current.length) {
      const columnList = columns.map((column) => `\`${column}\``).join(', ');
      return [`ADD INDEX \`${name}\` (${columnList})`];
    }

    const visibility = current[0].is_visible;
    if (
      (visibility !== 'YES' && visibility !== 'NO') ||
      current.length !== columns.length ||
      current.some(
        (column, position) =>
          column.column_name !== columns[position] ||
          Number(column.non_unique) !== 1 ||
          column.sub_part !== null ||
          column.index_type !== 'BTREE' ||
          column.collation !== 'A' ||
          column.is_visible !== visibility
      )
    ) {
      throw new Error(
        `Market depth wallet activity index ${name} is incompatible`
      );
    }
    return visibility === 'NO' ? [`ALTER INDEX \`${name}\` VISIBLE`] : [];
  });
}

export async function applyMarketDepthWalletActivityIndexes(
  source: DataSource = getDataSource()
): Promise<number> {
  const runner = source.createQueryRunner('master');
  let priorLockWaitTimeout: number | undefined;
  try {
    if (!(await runner.hasTable(MARKET_DEPTH_EVENTS_TABLE)))
      throw new Error(
        'Market depth wallet activity indexes require the events table'
      );

    const changes = await pendingIndexChanges(runner);
    if (!changes.length) return 0;

    const [settings]: { lock_wait_timeout: number | string }[] =
      await runner.query(
        'SELECT @@SESSION.lock_wait_timeout AS lock_wait_timeout'
      );
    const timeout = Number(settings.lock_wait_timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 31536000)
      throw new Error('Invalid session metadata lock timeout');
    priorLockWaitTimeout = timeout;
    await runner.query('SET SESSION lock_wait_timeout = 2');
    await runner.query(
      `ALTER TABLE \`${MARKET_DEPTH_EVENTS_TABLE}\` ${changes.join(', ')}, ALGORITHM=INPLACE, LOCK=NONE`
    );
    if ((await pendingIndexChanges(runner)).length)
      throw new Error('Market depth wallet activity indexes are not visible');
    return changes.length;
  } finally {
    try {
      if (priorLockWaitTimeout !== undefined)
        await runner.query('SET SESSION lock_wait_timeout = ?', [
          priorLockWaitTimeout
        ]);
    } finally {
      await runner.release();
    }
  }
}
