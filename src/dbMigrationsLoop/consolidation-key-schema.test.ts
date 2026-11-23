import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import { MetadataUtils } from 'typeorm/metadata-builder/MetadataUtils';
import * as Entities from '@/entities/entities';
import { CONSOLIDATION_KEY_LENGTH } from '@/constants';
import { consolidationTools } from '@/consolidation-tools';
import {
  IDENTITY_TDH_SYNC_SCOPE_TABLE,
  IDENTITY_TDH_SYNC_STATE_TABLE,
  SUBSCRIPTIONS_ID_KEY_MAP_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
} from '@/constants/db-tables';

type RunSql = (sql: string, params?: unknown[]) => Promise<unknown>;

const { widenConsolidationKeys } =
  require('../../migrations/20261122010000-widen-consolidation-keys.js') as {
    widenConsolidationKeys: (
      db: { runSql: RunSql },
      sleep: (delay: number) => Promise<void>
    ) => Promise<void>;
  };

// Columns that hold a consolidation key under another name.
const OTHER_KEY_COLUMNS: Record<string, string> = {
  [IDENTITY_TDH_SYNC_SCOPE_TABLE]: 'value',
  [IDENTITY_TDH_SYNC_STATE_TABLE]: 'walk_after'
};

// Composite indexes cap these below CONSOLIDATION_KEY_LENGTH (3,072 bytes).
const INDEX_CAPPED: Record<string, number> = {
  [SUBSCRIPTIONS_NFTS_TABLE]: 666,
  [SUBSCRIPTIONS_NFTS_FINAL_TABLE]: 666,
  [SUBSCRIPTIONS_REDEEMED_TABLE]: 567
};

// Tables created after the widening, at the full key width from the start:
// the migration has nothing to widen in them.
const BORN_WIDE = new Set<string>([SUBSCRIPTIONS_ID_KEY_MAP_TABLE]);

interface KeyColumn {
  table: string;
  column: string;
  length: number;
  nullable: boolean;
}

/** Every entity column that stores a consolidation key, at its entity length. */
function allKeyColumns(): KeyColumn[] {
  // Only the registered entities: the metadata storage is process-global and
  // can also hold classes another module instance loaded.
  const registered = new Set<unknown>(Object.values(Entities));
  const storage = getMetadataArgsStorage();
  return storage.tables
    .filter(
      (table) =>
        registered.has(table.target) &&
        table.type === 'regular' &&
        typeof table.name === 'string'
    )
    .flatMap((table) =>
      storage
        .filterColumns(
          MetadataUtils.getInheritanceTree(
            table.target as Parameters<
              typeof MetadataUtils.getInheritanceTree
            >[0]
          )
        )
        .filter(
          (column) =>
            (column.propertyName === 'consolidation_key' ||
              OTHER_KEY_COLUMNS[table.name!] === column.propertyName) &&
            // Only the widened varchar keys: a text copy has no width.
            column.options.type !== 'text'
        )
        .map((column) => ({
          table: table.name!,
          column: column.propertyName,
          length: Number(column.options.length),
          nullable: column.options.nullable === true
        }))
    )
    .sort((a, b) => a.table.localeCompare(b.table));
}

/** The key columns the widening migration covers: all but the born-wide. */
function entityKeyColumns(): KeyColumn[] {
  return allKeyColumns().filter((key) => !BORN_WIDE.has(key.table));
}

interface CurrentColumn {
  data_type: string | null;
  max_length: number;
  octet_length: number;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  collation_name: string;
  table_collation: string;
  row_format: string;
}

interface IndexPart {
  index_name: string;
  index_type: string;
  column_name: string;
  sub_part: number | null;
  data_type: string;
  max_length: number | null;
  octet_length: number | null;
}

/** A key part of an index, as information_schema reports it (utf8mb4). */
function part(
  index: string,
  column: string,
  type: string,
  chars?: number,
  subPart: number | null = null
): IndexPart {
  return {
    index_name: index,
    index_type: 'BTREE',
    column_name: column,
    sub_part: subPart,
    data_type: type,
    max_length: chars ?? null,
    octet_length: chars === undefined ? null : chars * 4
  };
}

function productionColumn(key: KeyColumn): CurrentColumn {
  const oldLength = [
    'tdh_memes_consolidation',
    'tdh_editions_consolidation',
    IDENTITY_TDH_SYNC_SCOPE_TABLE
  ].includes(key.table)
    ? 500
    : 200;
  return {
    data_type: 'varchar',
    max_length: oldLength,
    octet_length: oldLength * 4,
    is_nullable: key.nullable ? 'YES' : 'NO',
    column_default: null,
    collation_name: 'utf8mb4_0900_ai_ci',
    table_collation: 'utf8mb4_0900_ai_ci',
    row_format: 'Dynamic'
  };
}

function fakeDb(
  columns: Map<string, CurrentColumn | undefined>,
  onAlter: (sql: string) => void = () => undefined,
  indexes: Record<string, IndexPart[]> = {}
) {
  return jest.fn<ReturnType<RunSql>, Parameters<RunSql>>(
    async (sql, params) => {
      if (sql.includes('information_schema.statistics')) {
        const [table] = params as [string];
        return indexes[table] ?? [];
      }
      if (sql.includes('information_schema')) {
        const [column, table] = params as [string, string];
        const current = columns.get(`${table}.${column}`);
        return current ? [current] : [];
      }
      if (sql.startsWith('SELECT @@SESSION')) {
        return [{ lock_wait_timeout: '28800' }];
      }
      if (sql.startsWith('ALTER TABLE')) onAlter(sql);
      return [];
    }
  );
}

const ALTER =
  /^ALTER TABLE (\w+) MODIFY COLUMN (\w+) VARCHAR\((\d+)\) (NOT NULL|NULL DEFAULT NULL), ALGORITHM=INPLACE, LOCK=NONE$/;

function production() {
  return new Map(
    entityKeyColumns().map((key) => [
      `${key.table}.${key.column}`,
      productionColumn(key)
    ])
  );
}

describe('consolidation key widening migration', () => {
  it('sizes the key for a 16-wallet chain identity', () => {
    const wallets = Array.from(
      { length: 16 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`
    );
    const key = consolidationTools.buildConsolidationKey(wallets);
    expect(key).toHaveLength(687);
    expect(key.length).toBeLessThanOrEqual(CONSOLIDATION_KEY_LENGTH);
  });

  it('creates the tables made after the widening at the full key width', () => {
    expect(allKeyColumns().filter((key) => BORN_WIDE.has(key.table))).toEqual([
      {
        table: SUBSCRIPTIONS_ID_KEY_MAP_TABLE,
        column: 'consolidation_key',
        length: CONSOLIDATION_KEY_LENGTH,
        nullable: false
      }
    ]);
  });

  it('gives every key column its full width unless an index caps it', () => {
    const keys = entityKeyColumns();
    expect(keys.length).toBe(26);
    for (const key of keys) {
      expect([key.table, key.length]).toEqual([
        key.table,
        INDEX_CAPPED[key.table] ?? CONSOLIDATION_KEY_LENGTH
      ]);
    }
  });

  it('widens exactly the entity key columns, in place, to their entity lengths', async () => {
    const alters: string[] = [];
    const runSql = fakeDb(production(), (sql) => alters.push(sql));

    await widenConsolidationKeys({ runSql }, jest.fn());

    // The key sources go last, so a partial run never leaves them wider.
    expect(alters.slice(-2).map((sql) => ALTER.exec(sql)?.[1])).toEqual([
      'identities',
      'address_consolidation_keys'
    ]);
    const widened = alters
      .map((sql) => ALTER.exec(sql))
      .map((match) => {
        expect(match).not.toBeNull();
        const [, table, column, length, nullability] = match!;
        return {
          table,
          column,
          length: Number(length),
          nullable: nullability !== 'NOT NULL'
        };
      })
      .sort((a, b) => a.table.localeCompare(b.table));
    expect(widened).toEqual(entityKeyColumns());
    expect(runSql).toHaveBeenCalledWith('SET SESSION lock_wait_timeout = 3');
    expect(runSql).toHaveBeenLastCalledWith(
      'SET SESSION lock_wait_timeout = ?',
      [28800]
    );
  });

  it('does nothing on a fresh schema or once the columns are wide', async () => {
    const wide = new Map(
      entityKeyColumns().map((key) => [
        `${key.table}.${key.column}`,
        { ...productionColumn(key), max_length: key.length }
      ])
    );
    for (const columns of [wide, new Map<string, undefined>()]) {
      const runSql = fakeDb(columns);
      await widenConsolidationKeys({ runSql }, jest.fn());
      expect(
        runSql.mock.calls.filter(([sql]) => !sql.includes('information_schema'))
      ).toEqual([]);
    }
  });

  it.each([
    ['another type', { data_type: 'text' }],
    ['another collation', { collation_name: 'utf8mb4_bin' }],
    ['another nullability', { is_nullable: 'YES' as const }],
    ['a default', { column_default: '' }],
    ['a wider column', { max_length: 800 }],
    // latin1 varchar(200): one length byte, so widening would copy the table.
    ['a one-byte length', { octet_length: 200 }]
  ])(
    'alters nothing when one column has %s',
    async (_, change: Partial<CurrentColumn>) => {
      const columns = production();
      const identities = columns.get('identities.consolidation_key')!;
      columns.set('identities.consolidation_key', { ...identities, ...change });
      const alters: string[] = [];

      await expect(
        widenConsolidationKeys(
          { runSql: fakeDb(columns, (sql) => alters.push(sql)) },
          jest.fn()
        )
      ).rejects.toThrow('identities.consolidation_key');
      expect(alters).toEqual([]);
    }
  );

  it.each([
    [
      'an index over 3,072 bytes once widened',
      'Dynamic',
      [
        part('uq', 'consolidation_key', 'varchar', 200),
        part('uq', 'contract', 'varchar', 100),
        part('uq', 'token_id', 'bigint')
      ],
      'would take 3208 bytes'
    ],
    [
      'an indexed key in a COMPACT table',
      'Compact',
      [part('PRIMARY', 'consolidation_key', 'varchar', 200)],
      'caps indexes at 767 bytes'
    ],
    [
      'an index part it cannot size',
      'Dynamic',
      [
        part('k', 'consolidation_key', 'varchar', 200),
        part('k', 'amount', 'decimal')
      ],
      'Cannot size'
    ],
    [
      'a FULLTEXT index',
      'Dynamic',
      [
        {
          ...part('ft', 'consolidation_key', 'varchar', 200),
          index_type: 'FULLTEXT'
        }
      ],
      'non-BTREE'
    ]
  ])(
    'alters nothing when the table has %s',
    async (_, rowFormat: string, parts: IndexPart[], message: string) => {
      const columns = production();
      columns.set('identities.consolidation_key', {
        ...columns.get('identities.consolidation_key')!,
        row_format: rowFormat
      });
      const alters: string[] = [];

      await expect(
        widenConsolidationKeys(
          {
            runSql: fakeDb(columns, (sql) => alters.push(sql), {
              identities: parts
            })
          },
          jest.fn()
        )
      ).rejects.toThrow(message);
      expect(alters).toEqual([]);
    }
  );

  it('accepts an index at exactly the limit, a prefix index and an unindexed key in a COMPACT table', async () => {
    const columns = production();
    columns.set('identities.consolidation_key', {
      ...columns.get('identities.consolidation_key')!,
      row_format: 'Compact'
    });
    const alters: string[] = [];

    await widenConsolidationKeys(
      {
        runSql: fakeDb(columns, (sql) => alters.push(sql), {
          // The redemption primary key: 200 + 4 + 200 + 400 + 567 * 4 = 3,072.
          subscriptions_redeemed: [
            part('PRIMARY', 'contract', 'varchar', 50),
            part('PRIMARY', 'token_id', 'int'),
            part('PRIMARY', 'address', 'varchar', 50),
            part('PRIMARY', 'transaction', 'varchar', 100),
            part('PRIMARY', 'consolidation_key', 'varchar', 200)
          ],
          // A prefix keeps its size however wide the column grows.
          tdh_nft: [
            part('p', 'consolidation_key', 'varchar', 200, 191),
            part('p', 'contract', 'varchar', 500)
          ],
          identities: [part('k', 'profile_id', 'varchar', 50)]
        })
      },
      jest.fn()
    );

    expect(alters).toHaveLength(entityKeyColumns().length);
  });

  it('skips a column missing from an existing table, which entity sync adds', async () => {
    const columns = production();
    columns.set('identities.consolidation_key', {
      ...columns.get('identities.consolidation_key')!,
      data_type: null
    });
    const alters: string[] = [];

    await widenConsolidationKeys(
      { runSql: fakeDb(columns, (sql) => alters.push(sql)) },
      jest.fn()
    );

    expect(alters).toHaveLength(entityKeyColumns().length - 1);
    expect(alters.some((sql) => sql.includes('TABLE identities '))).toBe(false);
  });

  it('retries a metadata lock timeout and restores the session timeout', async () => {
    const lockTimeout = Object.assign(new Error('metadata lock timeout'), {
      code: 'ER_LOCK_WAIT_TIMEOUT'
    });
    const alters: string[] = [];
    let failed = false;
    const runSql = fakeDb(production(), (sql) => {
      alters.push(sql);
      if (!failed) {
        failed = true;
        throw lockTimeout;
      }
    });
    const sleep = jest.fn(async () => undefined);

    await widenConsolidationKeys({ runSql }, sleep);

    expect(alters[0]).toBe(alters[1]);
    expect(alters).toHaveLength(entityKeyColumns().length + 1);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(runSql).toHaveBeenLastCalledWith(
      'SET SESSION lock_wait_timeout = ?',
      [28800]
    );
  });
});
