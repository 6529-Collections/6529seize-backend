import {
  DELEGATIONS_TABLE,
  MEMES_CONTRACT,
  NEVER_DATE,
  USE_CASE_CONSOLIDATION,
  USE_CASE_MINTING
} from '@/constants';
import { Delegation } from '@/entities/IDelegation';
import { describeWithSeed } from '@/tests/_setup/seed';
import { DataSource } from 'typeorm';
import type { DelegationRow } from './delegation-scope-backfill';
import {
  applyScopeBackfillDiff,
  readDelegationRowsForBackfill
} from './delegation-scope-backfill.deps';

const COLD = '0xc01d000000000000000000000000000000000c01';
const HOT_1 = '0x1111111111111111111111111111111111111111';
const HOT_2 = '0x2222222222222222222222222222222222222222';
const HOT_3 = '0x3333333333333333333333333333333333333333';

function row(overrides: Partial<DelegationRow>): DelegationRow {
  return {
    block: 10,
    from_address: COLD,
    to_address: HOT_1,
    collection: MEMES_CONTRACT,
    use_case: USE_CASE_MINTING,
    expiry: NEVER_DATE,
    all_tokens: true,
    token_id: 0,
    ...overrides
  };
}

const tokenSpecific = row({ block: 10, to_address: HOT_1, token_id: 61 });
const revoked = row({ block: 11, to_address: HOT_2 });
const consolidation = row({
  block: 12,
  to_address: HOT_3,
  use_case: USE_CASE_CONSOLIDATION
});

describeWithSeed(
  'scope backfill writes',
  [{ table: DELEGATIONS_TABLE, rows: [tokenSpecific, revoked, consolidation] }],
  () => {
    const dataSource = new DataSource({
      type: 'mysql',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      entities: [Delegation],
      synchronize: false,
      logging: false,
      charset: 'utf8mb4',
      timezone: 'Etc/UTC'
    });

    beforeAll(async () => {
      await dataSource.initialize();
    });

    afterAll(async () => {
      await dataSource.destroy();
    });

    async function allRows() {
      const rows: Record<string, unknown>[] = await dataSource.query(
        `SELECT block, to_address, use_case, expiry, all_tokens, token_id FROM ${DELEGATIONS_TABLE} ORDER BY block`
      );
      return rows.map((r) => [
        Number(r.block),
        r.to_address,
        Number(r.use_case),
        Number(r.expiry),
        Boolean(Number(r.all_tokens)),
        Number(r.token_id)
      ]);
    }

    it('reads every row except use case 999', async () => {
      const rows = await readDelegationRowsForBackfill(dataSource);
      expect(rows.map((r) => r.block).sort((a, b) => a - b)).toEqual([10, 11]);
    });

    it('updates, deletes and inserts by primary key and leaves 999 rows alone', async () => {
      await applyScopeBackfillDiff(
        {
          updates: [
            {
              current: tokenSpecific,
              expected: { ...tokenSpecific, all_tokens: false, expiry: 1_900 },
              fields: ['all_tokens', 'expiry']
            }
          ],
          deletes: [revoked],
          inserts: [row({ block: 13, to_address: HOT_3, expiry: 5 })],
          unchanged: 0
        },
        dataSource
      );

      expect(await allRows()).toEqual([
        [10, HOT_1, USE_CASE_MINTING, 1_900, false, 61],
        [12, HOT_3, USE_CASE_CONSOLIDATION, NEVER_DATE, true, 0],
        [13, HOT_3, USE_CASE_MINTING, 5, true, 0]
      ]);
    });
  }
);
