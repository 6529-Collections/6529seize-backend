import 'reflect-metadata';
import * as mysql from 'mysql';
import { DROPS_TABLE, WAVE_RELAY_EVENTS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import {
  executeLegacyDmPurge,
  planLegacyDmPurge,
  type LegacyDmDb,
  type LegacyDmSql
} from './legacy-dm-purge';

const CUTOFF = Date.parse('2026-12-01T00:00:00Z');
const hex = (n: number) => `0x${String(n).padStart(64, '0')}`;

/** The purge's `?` SQL on the test database's own connection. */
// The pool's connections format `:name` parameters; the purge's `?` ones are
// formatted here, as the CLI's driver does (arrays become lists).
type Connection = {
  query: (sql: string, callback: (error: unknown, result: any) => void) => void;
};
function sqlOn(connection: Connection): LegacyDmSql {
  const run = (sql: string, params: readonly unknown[] = []) =>
    new Promise<any>((resolve, reject) =>
      connection.query(mysql.format(sql, [...params]), (error, result) =>
        error ? reject(error) : resolve(result)
      )
    );
  return {
    query: async (sql, params) => await run(sql, params),
    execute: async (sql, params) => (await run(sql, params)).affectedRows
  };
}
const inTransaction = <T>(work: (tx: LegacyDmSql) => Promise<T>) =>
  sqlExecutor.executeNativeQueriesInTransaction((tx) =>
    work(sqlOn(tx.connection as Connection))
  );
const db: LegacyDmDb = {
  query: (sql, params) => inTransaction((tx) => tx.query(sql, params)),
  execute: (sql, params) => inTransaction((tx) => tx.execute(sql, params)),
  inTransaction
};

const dmGroup = aUserGroup({ is_direct_message: true });
const dmWave = aWave({
  is_direct_message: true,
  chat_group_id: dmGroup.id,
  description_drop_id: 'dm-description'
});
const publicWave = aWave({ description_drop_id: 'public-description' });
// A wave the chain holds, as the chain mirror writes it: its chain id.
const chainWave = aWave(
  { description_drop_id: 'chain-description' },
  { id: hex(7), name: 'chain wave' }
);

const drop = (id: string, waveId: string) => ({
  id,
  wave_id: waveId,
  author_id: 'author-1',
  created_at: 1,
  title: null,
  parts_count: 1,
  drop_type: 'CHAT'
});

const relayEvent = (n: number, wave: string, dropId: string | null) => ({
  event_id: hex(100 + n),
  relay_id: 'relay-1',
  wave,
  wave_key: null,
  drop_id: dropId,
  kind: 1,
  author: `0x${'1'.repeat(40)}`,
  device_key: hex(200),
  auth_ref: hex(300),
  seq: n,
  claimed_time: 1,
  event: { id: hex(100 + n) },
  grant_proof: {},
  origin: 'relay',
  event_origin: 'OPERATION',
  status: 'logged',
  received_at: 1
});

describeWithSeed(
  "Legacy DM purge: the drop index's relay events",
  [
    withUserGroups([dmGroup]),
    withWaves([dmWave, publicWave, chainWave]),
    {
      table: DROPS_TABLE,
      rows: [
        drop('dm-description', dmWave.id),
        drop('dm-drop', dmWave.id),
        drop('public-drop', publicWave.id),
        drop('chain-drop', chainWave.id)
      ]
    },
    {
      table: WAVE_RELAY_EVENTS_TABLE,
      rows: [
        // A direct message's: by its wave, and by its drop.
        relayEvent(1, dmWave.id, 'dm-drop'),
        relayEvent(2, dmWave.id, null),
        relayEvent(3, dmWave.id, 'dm-description'),
        // A public wave's, and a wave the chain holds: never touched.
        relayEvent(4, publicWave.id, 'public-drop'),
        relayEvent(5, chainWave.id, 'chain-drop'),
        relayEvent(6, chainWave.id, null)
      ]
    }
  ],
  () => {
    const left = async () =>
      (
        await db.query<{ event_id: string }>(
          `select event_id from ${WAVE_RELAY_EVENTS_TABLE} order by event_id`
        )
      ).map((row) => row.event_id);

    it("deletes only a direct message's relay events, by its drops and by its wave", async () => {
      const plan = await planLegacyDmPurge(db);
      expect(plan.dmWaves).toBe(1);
      // By drop: the two events naming the DM's drops (its description's
      // included); by wave: the DM wave's three.
      expect(plan.rows[WAVE_RELAY_EVENTS_TABLE]).toBe(2);
      expect(plan.rows[`${WAVE_RELAY_EVENTS_TABLE} (by wave)`]).toBe(3);

      const result = await executeLegacyDmPurge(db, {
        nowMillis: CUTOFF,
        cutoffMillis: CUTOFF
      });
      expect(result.waves).toBe(1);
      expect(await left()).toEqual([hex(104), hex(105), hex(106)]);
      // A second run finds nothing more to delete.
      await executeLegacyDmPurge(db, {
        nowMillis: CUTOFF,
        cutoffMillis: CUTOFF
      });
      expect(await left()).toEqual([hex(104), hex(105), hex(106)]);
    });

    it('refuses before the cutoff and deletes nothing', async () => {
      await expect(
        executeLegacyDmPurge(db, {
          nowMillis: CUTOFF - 1,
          cutoffMillis: CUTOFF
        })
      ).rejects.toThrow('has not passed');
      expect(await left()).toHaveLength(6);
    });
  }
);
