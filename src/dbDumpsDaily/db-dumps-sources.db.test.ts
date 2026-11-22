import { CONSOLIDATIONS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { readChainTables } from './db-dumps-sources';

// The identity mirror's state table, as its entity on the mirror's branch
// creates it; this branch only reads it.
const MIRROR_STATE = 'identity_chain_mirror_state';
const NOW = Date.UTC(2026, 11, 2, 1, 0, 0);
const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

async function consolidation(n: number, block: number) {
  await sqlExecutor.execute(
    `INSERT INTO ${CONSOLIDATIONS_TABLE} (created_at, block, wallet1, wallet2, confirmed)
     VALUES (NOW(), :block, :wallet1, :wallet2, true)`,
    { block, wallet1: wallet(n), wallet2: wallet(n + 1) }
  );
}

async function mirrorAt(nextHeight: number, updatedAt: number) {
  await sqlExecutor.execute(
    `INSERT INTO ${MIRROR_STATE} (id, next_height, sync_phase, updated_at)
     VALUES ('identity', :nextHeight, NULL, :updatedAt)
     ON DUPLICATE KEY UPDATE next_height = :nextHeight, updated_at = :updatedAt`,
    { nextHeight, updatedAt }
  );
}

describe('the chain dumps under a moving identity mirror', () => {
  beforeEach(async () => {
    await sqlExecutor.execute(
      `CREATE TABLE IF NOT EXISTS ${MIRROR_STATE} (
         id varchar(20) NOT NULL PRIMARY KEY,
         next_height bigint NULL,
         sync_from_height bigint NULL,
         sync_phase varchar(20) NULL,
         sync_after varchar(100) NULL,
         last_full_sync_at bigint NULL,
         updated_at bigint NOT NULL
       )`
    );
    await sqlExecutor.execute(`DELETE FROM ${MIRROR_STATE}`);
    await sqlExecutor.execute(`DELETE FROM ${CONSOLIDATIONS_TABLE}`);
  });

  afterEach(async () => {
    await sqlExecutor.execute(`DROP TABLE IF EXISTS ${MIRROR_STATE}`);
    await sqlExecutor.execute(`DELETE FROM ${CONSOLIDATIONS_TABLE}`);
  });

  it('dumps the rows and names the height of one snapshot, whatever the mirror writes meanwhile', async () => {
    await mirrorAt(100, NOW - 60_000);
    await consolidation(1, 1_000_000_099);

    // The mirror applies height 100 after the dump has read its state.
    const during = await readChainTables(NOW, async () => {
      await consolidation(3, 1_000_000_100);
      await mirrorAt(101, NOW);
    });

    expect(
      during.map((read) => ('rows' in read ? read.rows.length : -1))
    ).toEqual([0, 1]);
    expect(during[1]).toMatchObject({
      table: 'consolidations',
      source: { kind: 'identity_chain_mirror', next_height: 100 }
    });

    // The next run sees both, and the height that goes with them.
    const after = await readChainTables(NOW);
    expect(after[1]).toMatchObject({
      source: { next_height: 101 }
    });
    expect('rows' in after[1] && after[1].rows.length).toBe(2);
  });

  it('skips both when a full pass has started by the time of the snapshot', async () => {
    await mirrorAt(100, NOW);
    await sqlExecutor.execute(
      `UPDATE ${MIRROR_STATE} SET sync_phase = 'IDENTITIES'`
    );
    const reads = await readChainTables(NOW);
    expect(reads.every((read) => 'skip' in read)).toBe(true);
  });
});
