import 'reflect-metadata';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { DropType } from '@/entities/IDrop';
import { Time } from '@/time';
import { WaveScoreService } from './wave-score.service';
import {
  LOW_TRUST_LEVEL_RAW,
  MAX_LEVEL_RAW_FOR_SCORE,
  RECENT_ACTIVITY_WINDOW_MS,
  TRUSTED_LEVEL_RAW
} from './wave-score.constants';

const now = 1_800_000_000_000;
const cutoff = now - RECENT_ACTIVITY_WINDOW_MS;
const waves = Array.from({ length: 3 }, () => aWave({}));
const levels = [-1, 0, 24, 25, 999, 1000, 25_000_000, 50_000_000];
const identities = levels.map((level_raw) => anIdentity({ level_raw }));
// profile_id is not unique: retain existing per-identity-row join semantics.
const duplicate = anIdentity({ level_raw: 2000 });
const authors = [
  ...identities.map((identity) => identity.profile_id!),
  randomUUID()
];
const fields = [
  'total_posts',
  'level_weighted_posts',
  'trusted_author_count',
  'low_trust_drop_count',
  'latest_trusted_drop_timestamp',
  'recent_level_weighted_posts'
] as const;

interface Post {
  readonly wave: number;
  readonly author: number;
  readonly createdAt: number;
  readonly dropType: DropType;
}

// Independent reference: the original per-drop aggregation, without compression.
const referenceSql = `
  SELECT d.wave_id,
    count(*) AS total_posts,
    sum(least(100, 100 * log10(1 + greatest(coalesce(i.level_raw, 0), 0)) / log10(1 + :maxLevel))) AS level_weighted_posts,
    count(distinct case when coalesce(i.level_raw, 0) >= :trusted then d.author_id end) AS trusted_author_count,
    sum(case when coalesce(i.level_raw, 0) < :lowTrust then 1 else 0 end) AS low_trust_drop_count,
    max(case when coalesce(i.level_raw, 0) >= :trusted then d.created_at else 0 end) AS latest_trusted_drop_timestamp,
    sum(case when d.created_at >= :cutoff then least(100, 100 * log10(1 + greatest(coalesce(i.level_raw, 0), 0)) / log10(1 + :maxLevel)) else 0 end) AS recent_level_weighted_posts
  FROM drops d LEFT JOIN identities i ON i.profile_id = d.author_id
  WHERE d.wave_id IN (:waveIds)
  GROUP BY d.wave_id`;

async function insertPosts(posts: readonly Post[]) {
  for (const post of posts) {
    await sqlExecutor.execute(
      `INSERT INTO drops (id, wave_id, author_id, created_at, parts_count, drop_type)
       VALUES (:id, :waveId, :authorId, :createdAt, 1, :dropType)`,
      {
        id: randomUUID(),
        waveId: waves[post.wave].id,
        authorId: authors[post.author],
        createdAt: post.createdAt,
        dropType: post.dropType
      }
    );
  }
}

describeWithSeed(
  'Wave score author aggregation',
  [
    withWaves(waves),
    withIdentities([
      ...identities,
      { ...duplicate, profile_id: identities[5].profile_id }
    ])
  ],
  () => {
    const service = new WaveScoreService(() => sqlExecutor);

    beforeEach(() => {
      jest.spyOn(Time, 'currentMillis').mockReturnValue(now);
    });
    afterEach(() => jest.restoreAllMocks());

    async function compareInputs(waveIds = waves.map((wave) => wave.id)) {
      const expected = await sqlExecutor.execute<
        Record<string, string | number>
      >(referenceSql, {
        waveIds,
        maxLevel: MAX_LEVEL_RAW_FOR_SCORE,
        trusted: TRUSTED_LEVEL_RAW,
        lowTrust: LOW_TRUST_LEVEL_RAW,
        cutoff
      });
      const actual = await service['getScoreInputRows'](waveIds, {});
      expect(actual).toHaveLength(waveIds.length);
      for (const row of actual) {
        const reference = expected.find(
          (entry) => entry.wave_id === row.wave_id
        );
        for (const field of fields) {
          expect(Number(row[field])).toBeCloseTo(
            Number(reference?.[field] ?? 0),
            6
          );
        }
        const [pressure] = await sqlExecutor.execute<{
          top_author_drops: number | null;
        }>(
          `SELECT max(posts) AS top_author_drops FROM (
            SELECT count(*) AS posts FROM drops WHERE wave_id=:waveId GROUP BY author_id
          ) author_posts`,
          { waveId: row.wave_id }
        );
        expect(Number(row.top_author_drops)).toBe(
          Number(pressure.top_author_drops ?? 0)
        );
      }
      return actual;
    }

    it('preserves thresholds, missing/duplicate identities, all drop types, and the inclusive time boundary', async () => {
      await insertPosts(
        authors.flatMap((_, author) => [
          { wave: 0, author, createdAt: cutoff - 1, dropType: DropType.CHAT },
          {
            wave: 0,
            author,
            createdAt: cutoff,
            dropType: DropType.PARTICIPATORY
          },
          { wave: 0, author, createdAt: cutoff + 1, dropType: DropType.WINNER },
          { wave: 1, author, createdAt: now, dropType: DropType.COMPETITION }
        ])
      );
      const rows = await compareInputs();
      expect(
        Number(rows.find((row) => row.wave_id === waves[2].id)?.total_posts)
      ).toBe(0);
      await compareInputs([waves[1].id]);
    });

    it('preserves inputs for generated author distributions and timestamp boundaries', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              wave: fc.integer({ min: 0, max: 1 }),
              author: fc.integer({ min: 0, max: authors.length - 1 }),
              createdAt: fc.constantFrom(
                0,
                cutoff - 1,
                cutoff,
                cutoff + 1,
                now
              ),
              dropType: fc.constantFrom(...Object.values(DropType))
            }),
            { maxLength: 35 }
          ),
          async (posts) => {
            await sqlExecutor.execute('DELETE FROM drops');
            await insertPosts(posts);
            await compareInputs();
          }
        ),
        { numRuns: 12 }
      );
    });

    it('uses the caller transaction and persists the unchanged score model', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await sqlExecutor.execute(
            `INSERT INTO drops (id, wave_id, author_id, created_at, parts_count, drop_type)
           VALUES (:id, :waveId, :authorId, :now, 1, 'CHAT')`,
            {
              id: randomUUID(),
              waveId: waves[0].id,
              authorId: authors[5],
              now
            },
            { wrappedConnection: connection }
          );
          const [input] = await service['getScoreInputRows']([waves[0].id], {
            connection
          });
          expect(Number(input.total_posts)).toBe(2);
          await service.refreshWaveScoresForWaveIds([waves[0].id], {
            connection
          });
          const [stored] = await sqlExecutor.execute<{
            wave_score_version: string;
            wave_score_calculated_at: number;
          }>(
            'SELECT wave_score_version, wave_score_calculated_at FROM wave_metrics WHERE wave_id=:waveId',
            { waveId: waves[0].id },
            { wrappedConnection: connection }
          );
          expect(stored).toMatchObject({
            wave_score_version: 'wave-score-v1',
            wave_score_calculated_at: now
          });
        }
      );
    });
  }
);
