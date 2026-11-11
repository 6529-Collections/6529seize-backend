import 'reflect-metadata';
import {
  CONTENT_MODERATION_DROP_STATES_TABLE,
  DROPS_TABLE,
  NEWSLETTER_EDITION_SOURCES_TABLE,
  NEWSLETTER_EDITIONS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { NewsletterEditionSourcesDb } from './newsletter-edition-sources.db';

const window = {
  start: Date.parse('2026-09-23T00:00:00Z'),
  end: Date.parse('2026-09-24T00:00:00Z')
};
const author = anIdentity(
  {},
  {
    profile_id: 'author',
    handle: 'Ayla',
    primary_address: '0x123',
    consolidation_key: '0x123'
  }
);
const waves = [
  aWave({}, { id: 'public', name: 'Public' }),
  aWave({ visibility_group_id: 'group' }, { id: 'private', name: 'Private' }),
  aWave({ is_direct_message: true }, { id: 'dm', name: 'DM' })
];
const liveDrops = [
  { id: 'ok-1', wave_id: 'public', serial_no: 1 },
  { id: 'ok-2', wave_id: 'public', serial_no: 2 },
  { id: 'ok-3', wave_id: 'public', serial_no: 3 },
  { id: 'moderated', wave_id: 'public', serial_no: 4 },
  { id: 'quarantined', wave_id: 'public', serial_no: 5 },
  { id: 'restricted', wave_id: 'private', serial_no: 6 },
  { id: 'dm', wave_id: 'dm', serial_no: 7 }
].map((drop) => ({
  ...drop,
  author_id: 'author',
  created_at: window.start,
  parts_count: 1
}));
const sourceRow = (
  editionId: string,
  sourceId: string,
  dropId: string | null,
  offset: number,
  extra: Record<string, unknown> = {}
) => ({
  edition_id: editionId,
  source_id: sourceId,
  kind: sourceId.split(':')[0].toUpperCase(),
  drop_id: dropId,
  wave_id: dropId
    ? dropId === 'restricted'
      ? 'private'
      : dropId === 'dm'
        ? 'dm'
        : 'public'
    : null,
  wave_name: dropId ? 'Public' : null,
  time: window.start + offset,
  collected_at: window.end + 1,
  canonical_url: `https://6529.io/waves/public?serialNo=${offset}`,
  title: null,
  author_handle: 'Ayla',
  content_fingerprint: 'f'.repeat(64),
  context_only: false,
  ...extra
});
const edition = (editionId: string, status: string) => ({
  edition_id: editionId,
  status,
  window_start: window.start,
  window_end: window.end,
  mode: 'scheduled',
  drop_id: status === 'PUBLISHED' ? `${editionId}-drop` : null,
  raw_output: '{}',
  rejection_reasons: null,
  sources: '[]',
  created_at: window.end,
  updated_at: window.end
});
const db = new NewsletterEditionSourcesDb(() => sqlExecutor);
const PUBLISHED = 'daily:2026-09-23';
const REJECTED = 'daily:2026-09-22';

describeWithSeed(
  'community memory public source reads',
  [
    withWaves(waves),
    withIdentities([author]),
    { table: DROPS_TABLE, rows: liveDrops },
    {
      table: CONTENT_MODERATION_DROP_STATES_TABLE,
      rows: [
        { drop_id: 'moderated', status: 'MODERATOR_REMOVED', updated_at: 1 },
        { drop_id: 'quarantined', status: 'AI_QUARANTINED', updated_at: 1 }
      ]
    },
    {
      table: NEWSLETTER_EDITIONS_TABLE,
      rows: [edition(PUBLISHED, 'PUBLISHED'), edition(REJECTED, 'REJECTED')]
    },
    {
      table: NEWSLETTER_EDITION_SOURCES_TABLE,
      rows: [
        sourceRow(PUBLISHED, 'drop:ok-1', 'ok-1', 1),
        sourceRow(PUBLISHED, 'drop:ok-2', 'ok-2', 2),
        // Same event time as ok-2: ordering must fall back to source_id.
        sourceRow(PUBLISHED, 'drop:ok-3', 'ok-3', 2),
        sourceRow(PUBLISHED, 'drop:deleted', 'deleted', 3),
        sourceRow(PUBLISHED, 'drop:moderated', 'moderated', 4),
        sourceRow(PUBLISHED, 'drop:quarantined', 'quarantined', 5),
        sourceRow(PUBLISHED, 'drop:restricted', 'restricted', 6),
        sourceRow(PUBLISHED, 'drop:dm', 'dm', 7),
        sourceRow(PUBLISHED, 'mint:the-memes:552', null, 8),
        sourceRow(PUBLISHED, 'identity:author', null, 9),
        sourceRow(PUBLISHED, 'drop:at-end', 'ok-1', 86_400_000),
        sourceRow(REJECTED, 'drop:ok-1', 'ok-1', 1)
      ]
    }
  ],
  () => {
    const ids = async (filter: Parameters<typeof db.listPublicSources>[0]) =>
      (await db.listPublicSources(filter, {})).map((row) => row.source_id);

    it('returns only published-edition records whose drops are still public', async () => {
      expect(await ids({ limit: 100 })).toEqual([
        'drop:ok-1',
        'drop:ok-2',
        'drop:ok-3',
        'mint:the-memes:552',
        'identity:author',
        'drop:at-end'
      ]);
      const rows = await db.listPublicSources({ limit: 1 }, {});
      expect(rows[0]).toEqual({
        edition_id: PUBLISHED,
        source_id: 'drop:ok-1',
        kind: 'DROP',
        drop_id: 'ok-1',
        wave_id: 'public',
        wave_name: 'Public',
        time: window.start + 1,
        collected_at: window.end + 1,
        canonical_url: 'https://6529.io/waves/public?serialNo=1',
        title: null,
        author_handle: 'Ayla',
        content_fingerprint: 'f'.repeat(64)
      });
    });

    it('drops records whose live drop loses visibility after publication', async () => {
      await sqlExecutor.execute(`delete from ${DROPS_TABLE} where id = 'ok-2'`);
      await sqlExecutor.execute(
        `insert into ${CONTENT_MODERATION_DROP_STATES_TABLE} (drop_id, status, updated_at) values ('ok-3', 'MODERATOR_REMOVED', 2)`
      );
      expect(
        await ids({ editionId: PUBLISHED, waveId: 'public', limit: 100 })
      ).toEqual(['drop:ok-1', 'drop:at-end']);
      expect(await ids({ editionId: REJECTED, limit: 100 })).toEqual([]);
    });

    it('filters by a start-inclusive, end-exclusive window', async () => {
      expect(
        await ids({ from: window.start + 1, to: window.start + 2, limit: 100 })
      ).toEqual(['drop:ok-1']);
      expect(
        await ids({
          from: window.start,
          to: window.start + 86_400_000,
          limit: 100
        })
      ).toEqual([
        'drop:ok-1',
        'drop:ok-2',
        'drop:ok-3',
        'mint:the-memes:552',
        'identity:author'
      ]);
      expect(
        await ids({ from: window.start + 86_400_000, limit: 100 })
      ).toEqual(['drop:at-end']);
    });

    it('pages by (time, source_id) so repeated walks give identical non-overlapping pages', async () => {
      const walk = async () => {
        const pages: string[][] = [];
        let after: { time: number; sourceId: string } | undefined;
        for (;;) {
          const rows = await db.listPublicSources({ limit: 3, after }, {});
          const page = rows.slice(0, 2);
          pages.push(page.map((row) => row.source_id));
          if (rows.length <= 2) return pages;
          after = { time: page[1].time, sourceId: page[1].source_id };
        }
      };
      const first = await walk();
      expect(first).toEqual([
        ['drop:ok-1', 'drop:ok-2'],
        ['drop:ok-3', 'mint:the-memes:552'],
        ['identity:author', 'drop:at-end']
      ]);
      expect(await walk()).toEqual(first);
    });
  }
);
