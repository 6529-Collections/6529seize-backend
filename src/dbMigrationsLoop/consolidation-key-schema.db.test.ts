import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { CONSOLIDATION_KEY_LENGTH } from '@/constants';
import { consolidationTools } from '@/consolidation-tools';
import { AddressConsolidationKey } from '@/entities/IAddressConsolidationKey';
import {
  ConsolidatedAggregatedActivity,
  ConsolidatedAggregatedActivityMemes
} from '@/entities/IAggregatedActivity';
import { IdentityEntity } from '@/entities/IIdentity';
import { IdentityTdhSyncScopeEntity } from '@/entities/IIdentityTdhSyncScope';
import { IdentityTdhSyncStateEntity } from '@/entities/IIdentityTdhSyncState';
import { NextGenTokenTDH } from '@/entities/INextGen';
import { ConsolidatedNFTOwner } from '@/entities/INFTOwner';
import {
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes
} from '@/entities/IOwnerBalances';
import {
  NFTFinalSubscription,
  NFTSubscription,
  RedeemedSubscription,
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionMode
} from '@/entities/ISubscription';
import { SubscriptionCoverageAlertStateEntity } from '@/entities/ISubscriptionCoverageAlertState';
import { SubscriptionCoverageRefreshRequestEntity } from '@/entities/ISubscriptionCoverageRefreshRequest';
import {
  ConsolidatedTDH,
  ConsolidatedTDHEditions,
  ConsolidatedTDHMemes,
  HistoricConsolidatedTDH,
  NftTDH
} from '@/entities/ITDH';
import {
  LatestTDHHistory,
  RecentTDHHistory,
  TDHHistory
} from '@/entities/ITDHHistory';
import { widenConsolidationKeysBeforeSchemaSync } from './consolidation-key-schema';
import { mysql2TypeOrmOptions } from '@/db/mysql-driver-compat';

const entities = [
  AddressConsolidationKey,
  ConsolidatedAggregatedActivity,
  ConsolidatedAggregatedActivityMemes,
  IdentityEntity,
  IdentityTdhSyncScopeEntity,
  IdentityTdhSyncStateEntity,
  NextGenTokenTDH,
  ConsolidatedNFTOwner,
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes,
  NFTSubscription,
  NFTFinalSubscription,
  RedeemedSubscription,
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionMode,
  SubscriptionCoverageAlertStateEntity,
  SubscriptionCoverageRefreshRequestEntity,
  ConsolidatedTDH,
  ConsolidatedTDHEditions,
  ConsolidatedTDHMemes,
  HistoricConsolidatedTDH,
  NftTDH,
  TDHHistory,
  LatestTDHHistory,
  RecentTDHHistory
];

const OTHER_KEY_COLUMNS: Record<string, string> = {
  identity_tdh_sync_scope: 'value',
  identity_tdh_sync_state: 'walk_after'
};
const OLD_500 = [
  'tdh_memes_consolidation',
  'tdh_editions_consolidation',
  'identity_tdh_sync_scope'
];

function keyOf(walletCount: number, offset = 0): string {
  return consolidationTools.buildConsolidationKey(
    Array.from(
      { length: walletCount },
      (_, i) => `0x${(offset + i + 1).toString(16).padStart(40, '0')}`
    )
  );
}

describe('consolidation key widening', () => {
  let source: DataSource;
  const targets: {
    table: string;
    column: string;
    length: number;
    nullable: boolean;
  }[] = [];

  beforeAll(async () => {
    source = await new DataSource({
      type: 'mysql',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      entities,
      ...mysql2TypeOrmOptions({ timezone: 'Z' })
    }).initialize();
    for (const entity of entities) {
      const metadata = source.getMetadata(entity);
      const column = metadata.findColumnWithPropertyName(
        OTHER_KEY_COLUMNS[metadata.tableName] ?? 'consolidation_key'
      )!;
      targets.push({
        table: metadata.tableName,
        column: column.databaseName,
        length: Number(column.length),
        nullable: column.isNullable
      });
    }
  });

  afterAll(async () => {
    for (const { table } of targets) await source.query(`DELETE FROM ${table}`);
    await source.destroy();
  });

  async function columnLengths(): Promise<Record<string, number>> {
    const lengths: Record<string, number> = {};
    for (const { table, column } of targets) {
      const [row]: { length: number }[] = await source.query(
        `SELECT CHARACTER_MAXIMUM_LENGTH AS length FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column]
      );
      lengths[`${table}.${column}`] = Number(row.length);
    }
    return lengths;
  }

  function productionWidths(): Record<string, number> {
    return Object.fromEntries(
      targets.map(({ table, column }) => [
        `${table}.${column}`,
        OLD_500.includes(table) ? 500 : 200
      ])
    );
  }

  /** Empties the tables and gives the key columns today's production widths. */
  async function narrowToProductionWidths() {
    for (const { table, column, nullable } of targets) {
      await source.query(`DELETE FROM ${table}`);
      const old = OLD_500.includes(table) ? 500 : 200;
      await source.query(
        `ALTER TABLE ${table} MODIFY COLUMN ${column} VARCHAR(${old}) ${
          nullable ? 'NULL DEFAULT NULL' : 'NOT NULL'
        }`
      );
    }
  }

  it('widens the production columns in place, keeps their rows and leaves entity sync nothing to do', async () => {
    await source.synchronize();
    await narrowToProductionWidths();
    const fourWallets = keyOf(4);
    await source.getRepository(AddressConsolidationKey).insert({
      address: '0x' + '1'.padStart(40, '0'),
      consolidation_key: fourWallets
    });
    await source.getRepository(RedeemedSubscription).insert({
      contract: '0x' + 'a'.padStart(40, '0'),
      token_id: 1,
      address: '0x' + '1'.padStart(40, '0'),
      transaction: '0x' + 'b'.padStart(64, '0'),
      consolidation_key: fourWallets,
      value: 0.06529,
      balance_after: 0
    });

    await widenConsolidationKeysBeforeSchemaSync(source);

    expect(await columnLengths()).toEqual(
      Object.fromEntries(
        targets.map(({ table, column, length }) => [
          `${table}.${column}`,
          length
        ])
      )
    );
    expect((await source.driver.createSchemaBuilder().log()).upQueries).toEqual(
      []
    );
    expect(await source.getRepository(AddressConsolidationKey).find()).toEqual([
      expect.objectContaining({ consolidation_key: fourWallets })
    ]);
    expect(
      await source.getRepository(RedeemedSubscription).count({
        where: { consolidation_key: fourWallets }
      })
    ).toBe(1);

    // A second run, as db-migrate does after sync, alters nothing.
    const statements: string[] = [];
    const runner = source.createQueryRunner('master');
    try {
      const migration =
        require('../../migrations/20261122010000-widen-consolidation-keys.js') as {
          up: (db: {
            runSql: (sql: string, params?: unknown[]) => Promise<unknown>;
          }) => Promise<void>;
        };
      await migration.up({
        runSql: (sql, params) => {
          statements.push(sql);
          return runner.query(sql, params);
        }
      });
    } finally {
      await runner.release();
    }
    expect(
      statements.filter((sql) => !sql.includes('information_schema'))
    ).toEqual([]);
  });

  it('stores a 16-wallet key in the widest composite keys, and each capped table its maximum', async () => {
    const sixteen = keyOf(16);
    expect(sixteen).toHaveLength(687);
    expect(CONSOLIDATION_KEY_LENGTH).toBeGreaterThanOrEqual(sixteen.length);

    await source.getRepository(IdentityEntity).query(
      `INSERT INTO identities (consolidation_key, profile_id, primary_address, tdh, rep, cic, level_raw)
       VALUES (?, ?, ?, 0, 0, 0, 0)`,
      [sixteen, 'profile-1', '0x' + '1'.padStart(40, '0')]
    );
    await source.getRepository(ConsolidatedNFTOwner).insert({
      consolidation_key: sixteen,
      contract: '0x' + 'a'.padStart(40, '0'),
      token_id: 1,
      balance: 1
    });
    await source.getRepository(ConsolidatedTDHEditions).insert({
      consolidation_key: sixteen,
      contract: '0x' + 'a'.padStart(40, '0'),
      id: 1,
      edition_id: 1,
      balance: 1,
      days_held: 1,
      hodl_rate: 1
    });
    // 15 and 13 wallets: the most these two indexes can hold.
    const fifteen = keyOf(15, 100);
    const thirteen = keyOf(13, 200);
    await source.getRepository(NFTSubscription).insert({
      consolidation_key: fifteen,
      contract: '0x' + 'a'.padStart(40, '0'),
      token_id: 1
    });
    await source.getRepository(RedeemedSubscription).insert({
      contract: '0x' + 'a'.padStart(40, '0'),
      token_id: 2,
      address: '0x' + '1'.padStart(40, '0'),
      transaction: '0x' + 'c'.padStart(64, '0'),
      consolidation_key: thirteen,
      value: 0.06529,
      balance_after: 0
    });

    const [identity]: { consolidation_key: string }[] = await source.query(
      'SELECT consolidation_key FROM identities WHERE consolidation_key = ?',
      [sixteen]
    );
    expect(identity.consolidation_key).toBe(sixteen);
    expect(
      await source
        .getRepository(ConsolidatedNFTOwner)
        .countBy({ consolidation_key: sixteen })
    ).toBe(1);
    expect(
      await source
        .getRepository(ConsolidatedTDHEditions)
        .countBy({ consolidation_key: sixteen })
    ).toBe(1);
    expect(
      await source
        .getRepository(NFTSubscription)
        .countBy({ consolidation_key: fifteen })
    ).toBe(1);
    expect(
      await source
        .getRepository(RedeemedSubscription)
        .countBy({ consolidation_key: thirteen })
    ).toBe(1);
  });

  it('refuses before altering anything when one table could not widen in place', async () => {
    await narrowToProductionWidths();
    // latin1 keeps a varchar(200) length in one byte: MySQL would copy the table.
    await source.query('ALTER TABLE tdh_nft CONVERT TO CHARACTER SET latin1');
    try {
      await expect(
        widenConsolidationKeysBeforeSchemaSync(source)
      ).rejects.toThrow('tdh_nft.consolidation_key');
      expect(await columnLengths()).toEqual(productionWidths());
    } finally {
      await source.query(
        'ALTER TABLE tdh_nft CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci'
      );
    }
    await widenConsolidationKeysBeforeSchemaSync(source);
    expect((await source.driver.createSchemaBuilder().log()).upQueries).toEqual(
      []
    );
  });
});
