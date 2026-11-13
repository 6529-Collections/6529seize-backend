import { DROPS_TABLE, DROPS_PARTS_TABLE } from '@/constants';
import { DropType } from '@/entities/IDrop';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { DropsDb } from './drops.db';

const publicWave = aWave(
  {},
  { id: 'public-search', name: 'public-search', serial_no: 1 }
);
const dm = aWave(
  { is_direct_message: true, visibility_group_id: 'dm-members' },
  { id: 'dm-search', name: 'dm-search', serial_no: 2 }
);
const malformedDm = aWave(
  { is_direct_message: true, visibility_group_id: null },
  { id: 'bad-dm', name: 'bad-dm', serial_no: 3 }
);
const child = aWave(
  { parent_wave_id: publicWave.id },
  { id: 'child-search', name: 'child-search', serial_no: 4 }
);
const grandchild = aWave(
  { parent_wave_id: child.id },
  { id: 'invalid-depth', name: 'invalid-depth', serial_no: 5 }
);
const searchWaves = [publicWave, dm, malformedDm, child, grandchild];
const repo = new DropsDb(() => sqlExecutor);
const row = (
  id: string,
  waveId: string,
  createdAt: number,
  serialNo: number
) => ({
  id,
  wave_id: waveId,
  created_at: createdAt,
  serial_no: serialNo,
  author_id: 'search-author',
  parts_count: 1,
  drop_type: DropType.CHAT,
  hide_link_preview: false
});

describeWithSeed(
  'global message search access and continuation',
  [
    withWaves(searchWaves),
    {
      table: DROPS_TABLE,
      rows: searchWaves.map((wave, index) =>
        row(`drop-${wave.id}`, wave.id, 100, index + 1)
      )
    },
    {
      table: DROPS_PARTS_TABLE,
      rows: searchWaves.map((wave) => ({
        drop_id: `drop-${wave.id}`,
        wave_id: wave.id,
        drop_part_id: 0,
        content: 'searchable message'
      }))
    }
  ],
  () => {
    it('includes only public waves and excludes malformed DMs and invalid nesting for anonymous callers', async () => {
      const results = await repo.searchDropsInWave(
        { term: 'searchable', limit: 20, offset: 0 },
        {}
      );
      expect(results.map((drop) => drop.id)).toEqual([
        'drop-public-search',
        'drop-child-search'
      ]);
    });
    it('returns direct messages only to eligible participants', async () => {
      const results = await repo.searchDropsInWave(
        {
          author_id: 'search-author',
          group_ids_user_is_eligible_for: ['dm-members'],
          limit: 20,
          offset: 0
        },
        {}
      );
      expect(results.map((drop) => drop.id)).toEqual([
        'drop-public-search',
        'drop-dm-search',
        'drop-child-search'
      ]);
    });
    it('continues after the last sort key when new messages arrive and timestamps tie', async () => {
      const first = await repo.searchDropsInWave(
        { author_id: 'search-author', limit: 1, offset: 0 },
        {}
      );
      expect(first[0].id).toBe('drop-public-search');
      await sqlExecutor.execute(
        `INSERT INTO ${DROPS_TABLE} (id, wave_id, created_at, serial_no, author_id, parts_count, drop_type, hide_link_preview) VALUES (:id, :wave_id, :created_at, :serial_no, :author_id, :parts_count, :drop_type, :hide_link_preview)`,
        row('new-message', publicWave.id, 200, 20)
      );
      const next = await repo.searchDropsInWave(
        { author_id: 'search-author', cursor: first[0], limit: 1, offset: 0 },
        {}
      );
      expect(next.map((drop) => drop.id)).toEqual(['drop-child-search']);
    });
    it('cannot return physically deleted drops even when their text parts remain', async () => {
      await repo.deleteDropEntity('drop-public-search', {});
      const results = await repo.searchDropsInWave(
        { term: 'searchable', limit: 20, offset: 0 },
        {}
      );
      expect(results.map((drop) => drop.id)).toEqual(['drop-child-search']);
    });
  }
);
