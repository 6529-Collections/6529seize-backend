import { DM_WAVES_SQL } from './legacy-dm-purge.inventory';
import {
  executeLegacyDmPurge,
  planLegacyDmPurge,
  type LegacyDmDb,
  type LegacyDmMediaEntry
} from './legacy-dm-purge';

const CUTOFF = Date.parse('2026-12-01T00:00:00Z');

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly kind: 'query' | 'execute';
}

/**
 * A scripted database: one DM wave with three drops, then nothing. It
 * records every statement so tests can check what the purge sent.
 */
function fakeDb(options: {
  waves?: { id: string; serial_no: number; description_drop_id: string }[];
  drops?: { id: string; author_id: string }[];
  blockers?: number;
  media?: boolean;
}) {
  const statements: Statement[] = [];
  const events: string[] = [];
  let wavesServed = false;
  let dropsServed = false;
  const db: LegacyDmDb = {
    query: async <T>(sql: string, params: readonly unknown[] = []) => {
      statements.push({ sql, params, kind: 'query' });
      const s = sql.replace(/\s+/g, ' ');
      if (s.startsWith('select count(*) as c')) {
        return [
          {
            c:
              s.includes('competition') ||
              s.includes('parent_wave_id') ||
              s.includes('art_curation')
                ? (options.blockers ?? 0)
                : 7
          }
        ] as T[];
      }
      if (s.startsWith('select count(distinct')) return [{ c: 2 }] as T[];
      if (s.includes('select w.id, w.serial_no, w.description_drop_id')) {
        if (wavesServed) return [] as T[];
        wavesServed = true;
        return (options.waves ?? []) as T[];
      }
      if (s.startsWith('select w.id from waves w where w.id = ?')) {
        return [{ id: params[0] }] as T[];
      }
      if (s.startsWith('select d.id, d.author_id from drops d')) {
        if (dropsServed) return [] as T[];
        dropsServed = true;
        return (options.drops ?? []) as T[];
      }
      if (s.includes('from attachments a join drop_attachments')) {
        return (
          options.media
            ? [
                {
                  id: 'att-1',
                  original_bucket: 'priv',
                  original_key: 'originals/a.pdf',
                  ipfs_cid: 'bafy1'
                }
              ]
            : []
        ) as T[];
      }
      if (s.startsWith('select distinct url from drop_medias')) {
        return (
          options.media
            ? [
                {
                  url: 'https://d3lqz0a4bldqgf.cloudfront.net/drops/0b2b1c4e-1111-4222-8333-944455556666/a.png'
                }
              ]
            : []
        ) as T[];
      }
      if (s.startsWith('select id from identity_notifications')) {
        return [{ id: 11 }, { id: 12 }] as T[];
      }
      return [] as T[];
    },
    execute: async (sql: string, params: readonly unknown[] = []) => {
      statements.push({ sql, params, kind: 'execute' });
      events.push(`sql:${sql.trim().split(/\s+/).slice(0, 3).join(' ')}`);
      return 1;
    },
    inTransaction: async (work) => work(db)
  };
  return { db, statements, events };
}

const WAVE = { id: 'dm-wave-1', serial_no: 5, description_drop_id: 'desc-1' };
const DROPS = [
  { id: 'd1', author_id: 'p1' },
  { id: 'd2', author_id: 'p2' },
  { id: 'd3', author_id: 'p1' }
];

describe('planLegacyDmPurge (dry run)', () => {
  it('sends only read statements and reports counts', async () => {
    const { db, statements } = fakeDb({ waves: [WAVE], drops: DROPS });
    const plan = await planLegacyDmPurge(db);
    expect(statements.length).toBeGreaterThan(20);
    for (const statement of statements) {
      expect(statement.kind).toBe('query');
      expect(statement.sql.trim().toLowerCase()).toMatch(/^select /);
      expect(statement.sql).not.toMatch(
        /\b(delete|update|insert|drop|alter|truncate)\b\s/i
      );
    }
    expect(plan.dmWaves).toBe(7);
    expect(plan.rows.drops_parts).toBe(7);
    expect(plan.media.dropMediaUrls).toBe(2);
    expect(plan.wavesWithOpenReports).toBe(2);
  });

  it('scopes every count to DM waves', async () => {
    const { db, statements } = fakeDb({});
    await planLegacyDmPurge(db);
    const unscoped = statements.filter(
      (s) =>
        !s.sql.includes('is_direct_message = 1') &&
        !s.sql.includes('is_direct_message = 1)')
    );
    expect(unscoped).toEqual([]);
  });
});

describe('executeLegacyDmPurge', () => {
  it('refuses before the cutoff', async () => {
    const { db, statements } = fakeDb({ waves: [WAVE], drops: DROPS });
    await expect(
      executeLegacyDmPurge(db, { nowMillis: CUTOFF - 1, cutoffMillis: CUTOFF })
    ).rejects.toThrow(/has not passed/);
    expect(statements).toEqual([]);
  });

  it('refuses while a blocker exists, before any write', async () => {
    const { db, statements } = fakeDb({
      waves: [WAVE],
      drops: DROPS,
      blockers: 1
    });
    await expect(
      executeLegacyDmPurge(db, { nowMillis: CUTOFF, cutoffMillis: CUTOFF })
    ).rejects.toThrow(/refused/);
    expect(statements.filter((s) => s.kind === 'execute')).toEqual([]);
  });

  it('rejects an out-of-range batch size', async () => {
    const { db } = fakeDb({});
    await expect(
      executeLegacyDmPurge(db, {
        nowMillis: CUTOFF,
        cutoffMillis: CUTOFF,
        batchSize: 0
      })
    ).rejects.toThrow(/Batch size/);
    await expect(
      executeLegacyDmPurge(db, {
        nowMillis: CUTOFF,
        cutoffMillis: CUTOFF,
        batchSize: 501
      })
    ).rejects.toThrow(/Batch size/);
  });

  it('writes nothing when no DM wave is left (idempotent rerun)', async () => {
    const { db, statements } = fakeDb({ waves: [] });
    const result = await executeLegacyDmPurge(db, {
      nowMillis: CUTOFF,
      cutoffMillis: CUTOFF
    });
    expect(result).toEqual({ waves: 0, drops: 0, rows: {} });
    expect(statements.filter((s) => s.kind === 'execute')).toEqual([]);
  });

  it('selects waves and drops only through the DM guard', async () => {
    const { db, statements } = fakeDb({ waves: [WAVE], drops: DROPS });
    const result = await executeLegacyDmPurge(db, {
      nowMillis: CUTOFF,
      cutoffMillis: CUTOFF
    });
    expect(result.waves).toBe(1);
    expect(result.drops).toBe(3);
    const wavePage = statements.find((s) =>
      s.sql.includes('w.description_drop_id from')
    );
    expect(wavePage?.sql).toContain(DM_WAVES_SQL);
    const batch = statements.find((s) =>
      s.sql.includes('select d.id, d.author_id')
    );
    expect(batch?.params.slice(0, 2)).toEqual([
      WAVE.id,
      WAVE.description_drop_id
    ]);
    const dropsDelete = statements.find((s) =>
      /^delete from drops where id in/.test(s.sql)
    );
    expect(dropsDelete?.sql).toContain('and wave_id = ?');
    expect(dropsDelete?.params).toEqual([['d1', 'd2', 'd3'], WAVE.id]);
  });

  it('binds only the batch ids, the description drop or the wave to writes', async () => {
    const { db, statements } = fakeDb({ waves: [WAVE], drops: DROPS });
    await executeLegacyDmPurge(db, { nowMillis: CUTOFF, cutoffMillis: CUTOFF });
    const allowed = new Set([
      'd1',
      'd2',
      'd3',
      'desc-1',
      WAVE.id,
      'p1',
      'p2',
      'att-1',
      11,
      12
    ]);
    for (const statement of statements.filter((s) => s.kind === 'execute')) {
      const values = statement.params.flatMap((p) =>
        Array.isArray(p) ? p : [p]
      );
      for (const value of values) {
        if (typeof value === 'number' && value > 1_000_000_000) continue; // timestamps
        if (value === 'gm! :gm1:' || typeof value === 'number') continue;
        expect(allowed.has(value as string)).toBe(true);
      }
    }
  });

  it('keeps the description drop and resets its text', async () => {
    const { db, statements } = fakeDb({ waves: [WAVE], drops: DROPS });
    await executeLegacyDmPurge(db, { nowMillis: CUTOFF, cutoffMillis: CUTOFF });
    const descriptionDropDelete = statements.find(
      (s) =>
        /^delete from drops where/.test(s.sql) &&
        JSON.stringify(s.params).includes('desc-1')
    );
    expect(descriptionDropDelete).toBeUndefined();
    const reset = statements.find((s) =>
      s.sql.includes('update drops_parts set content = ?')
    );
    expect(reset?.params).toEqual(['gm! :gm1:', 'desc-1', 'gm! :gm1:']);
  });

  it('hands media to the manifest before deleting the rows that name it', async () => {
    const { db, events } = fakeDb({ waves: [WAVE], drops: DROPS, media: true });
    const seen: LegacyDmMediaEntry[] = [];
    await executeLegacyDmPurge(db, {
      nowMillis: CUTOFF,
      cutoffMillis: CUTOFF,
      onMedia: (entries) => {
        events.push('media');
        seen.push(...entries);
      }
    });
    expect(events[0]).toBe('media');
    expect(seen.map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        'drop_media_url',
        'attachment_object',
        'attachment_ipfs'
      ])
    );
  });

  it('cancels pushes for the notifications it deletes', async () => {
    const { db, statements } = fakeDb({ waves: [WAVE], drops: DROPS });
    await executeLegacyDmPurge(db, { nowMillis: CUTOFF, cutoffMillis: CUTOFF });
    const cancelIndex = statements.findIndex((s) =>
      s.sql.includes('insert into push_notification_cancellations')
    );
    const deleteIndex = statements.findIndex((s) =>
      s.sql.includes('delete from identity_notifications')
    );
    expect(cancelIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(cancelIndex);
  });

  it('stops after maxWaves', async () => {
    const { db } = fakeDb({
      waves: [WAVE, { ...WAVE, id: 'dm-wave-2', serial_no: 6 }],
      drops: DROPS
    });
    const result = await executeLegacyDmPurge(db, {
      nowMillis: CUTOFF,
      cutoffMillis: CUTOFF,
      maxWaves: 1
    });
    expect(result.waves).toBe(1);
  });

  it('leaves waves under a legal hold out of the selection', async () => {
    const { db, statements } = fakeDb({ waves: [WAVE], drops: DROPS });
    await executeLegacyDmPurge(db, {
      nowMillis: CUTOFF,
      cutoffMillis: CUTOFF,
      heldWaveIds: ['held-wave']
    });
    const wavePage = statements.find((s) =>
      s.sql.includes('w.description_drop_id from')
    );
    expect(wavePage?.sql).toContain('and w.id not in (?)');
    expect(wavePage?.params).toEqual([0, ['held-wave']]);
  });
});
