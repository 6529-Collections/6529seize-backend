import fc from 'fast-check';
import { BadRequestException } from '@/exceptions';
import { CommunityMemorySourceRow } from '@/newsletter/newsletter-edition-sources.db';
import { TEAM_WAVE_IDS } from '@/newsletter/newsletter.config';
import {
  classifySource,
  decodeSourceCursor,
  encodeSourceCursor,
  handleListCommunityMemorySources,
  listCommunityMemorySources
} from './community-memory.handlers';

const row = (
  i: number,
  extra: Partial<CommunityMemorySourceRow> = {}
): CommunityMemorySourceRow => ({
  edition_id: 'daily:2026-09-23',
  source_id: `drop:${String(i).padStart(3, '0')}`,
  kind: 'DROP',
  drop_id: String(i),
  wave_id: 'public',
  wave_name: 'Public',
  time: 1_000 + i,
  collected_at: 90_000,
  canonical_url: `https://6529.io/waves/public?serialNo=${i}`,
  title: null,
  author_handle: 'Ayla',
  content_fingerprint: 'a'.repeat(64),
  ...extra
});

function fakeDb(rows: CommunityMemorySourceRow[]) {
  return {
    listPublicSources: jest.fn(async (filter) => {
      let selected = rows.filter(
        (r) =>
          (filter.waveId === undefined || r.wave_id === filter.waveId) &&
          (filter.editionId === undefined ||
            r.edition_id === filter.editionId) &&
          (filter.from === undefined || r.time >= filter.from) &&
          (filter.to === undefined || r.time < filter.to)
      );
      if (filter.after) {
        const { time, sourceId } = filter.after;
        selected = selected.filter(
          (r) => r.time > time || (r.time === time && r.source_id > sourceId)
        );
      }
      return selected
        .sort(
          (a, b) => a.time - b.time || a.source_id.localeCompare(b.source_id)
        )
        .slice(0, filter.limit);
    })
  };
}

describe('community memory sources handler', () => {
  it('validates the query, rejecting unknown fields, bad times, bad limits and bad cursors', async () => {
    const bad = [
      { limit: '0' },
      { limit: '101' },
      { from: 'yesterday' },
      { to: '-5' },
      { nope: '1' },
      { cursor: 'not-base64-json' },
      { cursor: Buffer.from('{"v":2}').toString('base64url') },
      { from: '2026-09-23T00:00:00Z', to: '2026-09-22T00:00:00Z' },
      { from: '2026-09-01T00:00:00Z', to: '2026-10-03T00:00:00Z' }
    ];
    for (const query of bad) {
      await expect(
        handleListCommunityMemorySources({ query, params: {} } as never)
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('accepts ISO and millisecond bounds and passes the half-open window through', async () => {
    const db = fakeDb([row(1), row(2), row(3)]);
    const page = await listCommunityMemorySources(
      {
        from: Date.parse('1970-01-01T00:00:01.001Z'),
        to: 1003,
        limit: 50
      },
      {},
      db
    );
    expect(page.data.map((s) => s.source_id)).toEqual(['drop:001', 'drop:002']);
    expect(db.listPublicSources).toHaveBeenCalledWith(
      expect.objectContaining({ from: 1001, to: 1003, limit: 51 }),
      {}
    );
  });

  it('maps rows to traceable records with derived classification', async () => {
    const rows = [
      row(1),
      row(2, {
        source_id: 'winner:c:e',
        kind: 'WINNER',
        wave_id: 'stage',
        wave_name: 'Main Stage',
        title: 'Winning Art'
      }),
      row(3, {
        source_id: 'mint:the-memes:552',
        kind: 'MINT',
        drop_id: null,
        wave_id: null,
        wave_name: null
      }),
      row(4, { wave_id: TEAM_WAVE_IDS[0], wave_name: 'Announcements' }),
      row(5, {
        source_id: 'identity:p',
        kind: 'IDENTITY',
        drop_id: null,
        wave_id: null,
        wave_name: null
      })
    ];
    const page = await listCommunityMemorySources(
      { limit: 50 },
      {},
      fakeDb(rows)
    );
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBeNull();
    expect(page.data[0]).toEqual({
      source_id: 'drop:001',
      kind: 'DROP',
      canonical_url: 'https://6529.io/waves/public?serialNo=1',
      title: null,
      author_handle: 'Ayla',
      wave_id: 'public',
      wave_name: 'Public',
      observed_at: '1970-01-01T00:01:30.000Z',
      time: '1970-01-01T00:00:01.001Z',
      content_fingerprint: 'a'.repeat(64),
      provenance: {
        edition_id: 'daily:2026-09-23',
        collected_at: '1970-01-01T00:01:30.000Z'
      },
      classification: 'DISCUSSION'
    });
    expect(page.data.map((s) => s.classification)).toEqual([
      'DISCUSSION',
      'OUTCOME',
      'OUTCOME',
      'ANNOUNCEMENT',
      null
    ]);
    expect(classifySource({ kind: 'DROP', wave_id: null })).toBe('DISCUSSION');
  });

  it('pages deterministically with a base64 (time, source_id) cursor and no gaps or overlaps', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            i: fc.integer({ min: 0, max: 999 }),
            time: fc.integer({ min: 0, max: 5 })
          }),
          { maxLength: 60 }
        ),
        fc.integer({ min: 1, max: 7 }),
        async (items, limit) => {
          const unique = new Map(
            items.map((item) => [item.i, row(item.i, { time: item.time })])
          );
          const rows = Array.from(unique.values());
          const db = fakeDb(rows);
          const walk = async () => {
            const seen: string[] = [];
            let cursor: string | undefined;
            for (let pages = 0; pages < 200; pages++) {
              const page = await listCommunityMemorySources(
                { limit, cursor },
                {},
                db
              );
              seen.push(...page.data.map((s) => s.source_id));
              expect(page.data.length).toBeLessThanOrEqual(limit);
              expect(page.has_more).toBe(page.next_cursor !== null);
              if (!page.next_cursor) return seen;
              cursor = page.next_cursor;
            }
            throw new Error('did not terminate');
          };
          const first = await walk();
          const second = await walk();
          expect(second).toEqual(first);
          expect(new Set(first).size).toBe(rows.length);
          const expected = rows
            .sort(
              (a, b) =>
                a.time - b.time || a.source_id.localeCompare(b.source_id)
            )
            .map((r) => r.source_id);
          expect(first).toEqual(expected);
        }
      ),
      { numRuns: 25 }
    );
  });

  it('round-trips cursors and rejects tampered ones', () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.stringMatching(/^[a-z:0-9-]{1,50}$/),
        (time, sourceId) => {
          const cursor = encodeSourceCursor({ time, sourceId });
          return (
            /^[A-Za-z0-9_-]+$/.test(cursor) &&
            JSON.stringify(decodeSourceCursor(cursor)) ===
              JSON.stringify({ time, sourceId })
          );
        }
      )
    );
    expect(decodeSourceCursor(undefined)).toBeUndefined();
    expect(() => decodeSourceCursor('eyJ2IjoxfQ')).toThrow(BadRequestException);
  });
});
