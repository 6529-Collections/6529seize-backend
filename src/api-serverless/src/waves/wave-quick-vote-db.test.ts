import * as fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import {
  legacyGetView,
  withLegacyCompetitionGetFacade
} from '@/competitions/legacy-competition-get-facade';
import * as tables from '@/constants';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import {
  nativeOriginalPrimaryFixture,
  seedNativeOriginalPrimaryFixture
} from '@/tests/fixtures/native-competition.fixture';
import { WaveQuickVoteDb } from './wave-quick-vote.db';

const wave = aWave(
  { type: WaveType.RANK },
  { id: 'quick-vote', name: 'Quick Vote' }
);
const other = aWave({ type: WaveType.RANK }, { id: 'other', name: 'Other' });
const param = { wave_id: wave.id, identity_id: 'viewer' };
const db = new WaveQuickVoteDb(() => sqlExecutor);

async function insert(
  table: string,
  row: Record<string, unknown>
): Promise<void> {
  const columns = Object.keys(row);
  await sqlExecutor.execute(
    `INSERT INTO ${table} (${columns.map((key) => `\`${key}\``).join(',')})
     VALUES (${columns.map((key) => `:${key}`).join(',')})`,
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value !== null && typeof value === 'object'
          ? JSON.stringify(value)
          : value
      ])
    )
  );
}

async function baseline(
  identity_id = param.identity_id,
  wave_id = param.wave_id
) {
  return await sqlExecutor.execute<{ id: string; skipped_at: number | null }>(
    `SELECT d.id, skips.skipped_at
     FROM ${legacyGetView(tables.DROPS_TABLE)} d
     LEFT JOIN ${legacyGetView(tables.DROP_VOTER_STATE_TABLE)} v
       ON v.drop_id=d.id AND v.wave_id=:wave_id AND v.voter_id=:identity_id
     LEFT JOIN ${tables.DROP_QUICKVOTE_SKIPS_TABLE} skips
       ON skips.drop_id=d.id AND skips.wave_id=:wave_id AND skips.identity_id=:identity_id
     WHERE d.wave_id=:wave_id AND d.drop_type='PARTICIPATORY' AND IFNULL(v.votes,0)=0
     ORDER BY (skips.drop_id IS NOT NULL), skips.skipped_at ASC, d.created_at DESC, d.serial_no DESC`,
    { identity_id, wave_id }
  );
}

describeWithSeed(
  'native quick vote query parity',
  withWaves([wave, other]),
  () => {
    let competitionId: string;
    beforeEach(async () => {
      const primary = await seedNativeOriginalPrimaryFixture(wave);
      competitionId = primary.id;
      const sibling = {
        ...nativeOriginalPrimaryFixture(wave),
        id: randomUUID(),
        legacy_wave_id: null
      };
      await insert(tables.COMPETITIONS_TABLE, sibling);
      const rows = [
        ['missing', 300, 'ACTIVE', 'CHAT'],
        ['zero', 250, 'ACTIVE', 'COMPETITION'],
        ['same-time-a', 200, 'ACTIVE', 'COMPETITION'],
        ['same-time-b', 200, 'ACTIVE', 'COMPETITION'],
        ['orphan', 150, null, 'PARTICIPATORY'],
        ['skipped-early', 90, 'ACTIVE', 'COMPETITION'],
        ['skipped-late', 100, 'ACTIVE', 'COMPETITION'],
        ['positive', 400, 'ACTIVE', 'COMPETITION'],
        ['negative', 500, 'ACTIVE', 'COMPETITION'],
        ['winner', 600, 'WINNER', 'PARTICIPATORY'],
        ['withdrawn', 700, 'WITHDRAWN', 'PARTICIPATORY'],
        ['disqualified', 800, 'DISQUALIFIED', 'PARTICIPATORY'],
        ['sibling-only', 900, null, 'COMPETITION']
      ] as const;
      for (const [id, created_at, status, drop_type] of rows) {
        await insert(tables.DROPS_TABLE, {
          id,
          wave_id: wave.id,
          author_id: 'artist',
          created_at,
          parts_count: 1,
          drop_type
        });
        if (status) {
          await insert(tables.COMPETITION_ENTRIES_TABLE, {
            id: `entry-${id}`,
            competition_id: primary.id,
            wave_id: wave.id,
            drop_id: id,
            submitter_id: 'artist',
            status,
            config_version: 1,
            submitted_at: created_at
          });
        }
      }
      for (const [id, value] of [
        ['zero', 0],
        ['positive', 10],
        ['negative', -10]
      ] as const) {
        await insert(tables.COMPETITION_VOTES_TABLE, {
          id: `vote-${id}`,
          competition_id: primary.id,
          entry_id: `entry-${id}`,
          voter_profile_id: 'viewer',
          value,
          credit_spent: Math.abs(value),
          created_at: 0,
          updated_at: 0
        });
      }
      for (const [id, skipped_at] of [
        ['skipped-early', 1],
        ['skipped-late', 2]
      ] as const) {
        await insert(tables.DROP_QUICKVOTE_SKIPS_TABLE, {
          ...param,
          drop_id: id,
          skipped_at
        });
      }
      for (const id of ['orphan', 'sibling-only', 'zero']) {
        await insert(tables.COMPETITION_ENTRIES_TABLE, {
          id: `sibling-${id}`,
          competition_id: sibling.id,
          wave_id: wave.id,
          drop_id: id,
          submitter_id: 'artist',
          status: id === 'zero' ? 'WITHDRAWN' : 'ACTIVE',
          config_version: 1,
          submitted_at: 1
        });
        await insert(tables.COMPETITION_VOTES_TABLE, {
          id: `sibling-vote-${id}`,
          competition_id: sibling.id,
          entry_id: `sibling-${id}`,
          voter_profile_id: 'viewer',
          value: 10,
          credit_spent: 10,
          created_at: 0,
          updated_at: 0
        });
      }
      // Unrelated chat history must never become a Quick Vote candidate.
      await sqlExecutor.bulkInsert(
        tables.DROPS_TABLE,
        Array.from({ length: 1000 }, (_, n) => ({
          id: `chat-${n}`,
          wave_id: wave.id,
          author_id: 'artist',
          created_at: n,
          parts_count: 1,
          drop_type: 'CHAT'
        })),
        ['id', 'wave_id', 'author_id', 'created_at', 'parts_count', 'drop_type']
      );
    });

    async function assertParity(identity_id = 'viewer', wave_id = wave.id) {
      const expected = await baseline(identity_id, wave_id);
      const params = { identity_id, wave_id };
      await withLegacyCompetitionGetFacade(async () => {
        const counts = await db.countDrops(params, {});
        expect(counts).toEqual({
          total_count: expected.length,
          left_to_vote_in_current_round: expected.filter(
            (row) => row.skipped_at === null
          ).length
        });
        const selected = [];
        for (const skipped of [false, true]) {
          selected.push(
            ...(await db.findDrops(
              { ...params, skip: 0, limit: 100 },
              skipped,
              {}
            ))
          );
        }
        expect(selected.map((row) => row.id)).toEqual(
          expected.map((row) => row.id)
        );
        expect(
          selected.every((row) => row.drop_type === DropType.PARTICIPATORY)
        ).toBe(true);
      });
    }

    it('preserves signed votes, legacy orphans, original ownership, and stable skipped ordering', async () => {
      expect((await baseline()).map((row) => row.id)).toEqual([
        'missing',
        'zero',
        'same-time-b',
        'same-time-a',
        'orphan',
        'skipped-early',
        'skipped-late'
      ]);
      await assertParity();
      await assertParity('different-viewer');
      await assertParity('viewer', other.id);
      const first = await withLegacyCompetitionGetFacade(() =>
        db.findNextUndiscoveredDrop(param, {})
      );
      expect(first?.id).toBe('missing');
      const page = await db.findDrops(
        { ...param, skip: 1, limit: 2 },
        false,
        {}
      );
      expect(page.map((row) => row.id)).toEqual(['zero', 'same-time-b']);
    });

    it('keeps parity as native allocations change between zero, positive, and negative', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(
            fc.constantFrom(-100, 0, 100),
            fc.constantFrom(-100, 0, 100)
          ),
          async ([positive, negative]) => {
            for (const [id, value] of [
              ['positive', positive],
              ['negative', negative]
            ] as const) {
              await sqlExecutor.execute(
                `UPDATE ${tables.COMPETITION_VOTES_TABLE} SET value=:value
          WHERE competition_id=:competitionId AND entry_id=:entryId`,
                {
                  value,
                  competitionId,
                  entryId: `entry-${id}`
                }
              );
            }
            await assertParity();
          }
        ),
        { numRuns: 8 }
      );
    });

    it('enforces the uniqueness guarantees used for cardinality and stable ordering', async () => {
      const original = await sqlExecutor.oneOrNull<{ serial_no: number }>(
        `SELECT serial_no FROM ${tables.DROPS_TABLE} WHERE id='missing'`
      );
      await expect(
        insert(tables.DROPS_TABLE, {
          id: 'duplicate-serial',
          serial_no: original!.serial_no,
          wave_id: wave.id,
          author_id: 'artist',
          created_at: 300,
          parts_count: 1,
          drop_type: 'PARTICIPATORY'
        })
      ).rejects.toThrow('PRIMARY');
      await expect(
        insert(tables.COMPETITION_ENTRIES_TABLE, {
          id: 'duplicate-entry',
          competition_id: competitionId,
          wave_id: wave.id,
          drop_id: 'missing',
          submitter_id: 'artist',
          status: 'WITHDRAWN',
          config_version: 1,
          submitted_at: 300
        })
      ).rejects.toThrow('uq_competition_entry_drop');
      await expect(
        insert(tables.COMPETITION_VOTES_TABLE, {
          id: 'duplicate-vote',
          competition_id: competitionId,
          entry_id: 'entry-zero',
          voter_profile_id: 'viewer',
          value: 0,
          credit_spent: 0,
          created_at: 0,
          updated_at: 0
        })
      ).rejects.toThrow('uq_competition_vote_actor_entry');
    });

    it('uses the supplied transaction for allocation and skip reads', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx = { connection };
          await db.insertSkip({ ...param, drop_id: 'missing' }, ctx);
          expect(await db.countDrops(param, ctx)).toEqual({
            total_count: 7,
            left_to_vote_in_current_round: 4
          });
          expect((await db.findNextUndiscoveredDrop(param, ctx))?.id).toBe(
            'zero'
          );
        }
      );
    });

    it('keeps retained participatory drops without an original competition', async () => {
      await insert(tables.DROPS_TABLE, {
        id: 'unowned-orphan',
        wave_id: other.id,
        author_id: 'artist',
        created_at: 1,
        parts_count: 1,
        drop_type: 'PARTICIPATORY'
      });
      await assertParity('viewer', other.id);
    });
  }
);
