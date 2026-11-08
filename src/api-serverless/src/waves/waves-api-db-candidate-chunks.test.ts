import * as mysql from 'mysql';
import { DbQueryOptions } from '@/db-query.options';
import { PROXY_PIN_STATEMENT_BYTES } from '@/db/proxy-session-pinning';
import { SqlExecutor } from '@/sql-executor';
import { WavesApiDb } from './waves.api.db';

type Params = Record<string, unknown>;

/** The API driver's named-parameter formatting (my-sql.helpers). */
function format(sql: string, params: Params): string {
  return sql.replace(/:(\w+)/g, (text, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) return text;
    const value = params[key];
    return Array.isArray(value)
      ? value.map((item) => mysql.escape(item)).join(', ')
      : mysql.escape(value);
  });
}

// A full candidate window: 1,000 wave UUIDs, about 40 KB once inlined.
const candidateIds = Array.from(
  { length: 1_000 },
  (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
);
const matching = new Set(candidateIds.filter((_, i) => i % 97 === 0));

function repoRecording() {
  const statements: {
    sql: string;
    params: Params;
    options?: DbQueryOptions;
  }[] = [];
  let active = 0;
  let maxActive = 0;
  const execute = jest.fn(
    async (sql: string, params: Params, options?: DbQueryOptions) => {
      // The shared viewer-group table's one-off collation check: no rows
      // keeps the inlined group list these size checks were written for.
      if (sql.includes('information_schema.columns')) return [];
      statements.push({ sql: format(sql, params), params, options });
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return (params.waveIds as string[])
        .filter((id) => matching.has(id))
        .map((wave_id) => ({ wave_id }));
    }
  );
  const repo = new WavesApiDb(
    () => ({ execute }) as unknown as SqlExecutor
  ) as unknown as Record<
    string,
    (param: Record<string, unknown>) => Promise<Set<string>>
  >;
  return { repo, statements, maxActive: () => maxActive };
}

describe('wave overview candidate lookups', () => {
  it.each([
    ['findPinnedCandidateWaveIds', {}],
    ['findMutedCandidateWaveIds', {}],
    ['findFollowedCandidateWaveIds', { eligibleGroups: ['group-a', 'group-b'] }]
  ])(
    '%s keeps every statement below the proxy pinning size and unions chunk results',
    async (method, extra) => {
      const { repo, statements } = repoRecording();
      const result = await repo[method]({
        authenticated_user_id: 'reader',
        waveIds: candidateIds,
        ...extra
      });
      expect(result).toEqual(matching);
      expect(statements.length).toBeGreaterThan(1);
      for (const { sql } of statements) {
        expect(Buffer.byteLength(sql)).toBeLessThanOrEqual(
          PROXY_PIN_STATEMENT_BYTES
        );
      }
      const queried = statements.flatMap(
        ({ params }) => params.waveIds as string[]
      );
      expect(queried).toEqual(candidateIds);
    }
  );

  it('uses one statement for a first-page window of 250 candidates', async () => {
    const { repo, statements } = repoRecording();
    await repo.findPinnedCandidateWaveIds({
      authenticated_user_id: 'reader',
      waveIds: candidateIds.slice(0, 250)
    });
    expect(statements).toHaveLength(1);
  });

  it('runs muted chunks one at a time on a caller-owned connection', async () => {
    const { repo, statements, maxActive } = repoRecording();
    const connection = { connection: {} };
    await repo.findMutedCandidateWaveIds({
      authenticated_user_id: 'reader',
      waveIds: candidateIds,
      connection
    });
    expect(statements.length).toBeGreaterThan(1);
    expect(maxActive()).toBe(1);
    for (const { options } of statements) {
      expect(options?.wrappedConnection).toBe(connection);
    }
  });

  it('skips the database without an authenticated reader', async () => {
    const { repo, statements } = repoRecording();
    await expect(
      repo.findPinnedCandidateWaveIds({
        authenticated_user_id: null,
        waveIds: candidateIds
      })
    ).resolves.toEqual(new Set());
    expect(statements).toHaveLength(0);
  });
});
