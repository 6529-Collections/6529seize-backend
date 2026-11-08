import * as mysql from 'mysql';
import { PROXY_PIN_STATEMENT_BYTES } from '@/db/proxy-session-pinning';
import { IN_LIST_MAX_VALUES } from '@/db/in-list-pages';
import { NativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';

/** The executor's named-parameter expansion (my-sql.helpers prepareStatement). */
function formatted(sql: string, params: Record<string, unknown>): string {
  return sql.replace(/:(\w+)/g, (text, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) return text;
    const value = params[key];
    return Array.isArray(value)
      ? value.map((it) => mysql.escape(it)).join(', ')
      : mysql.escape(value);
  });
}

function repositoryWith(
  rows: (page: string[]) => {
    voterProfileId: string;
    entryId: string;
    value: number;
  }[]
) {
  const statements: { sql: string; params: Record<string, unknown> }[] = [];
  const db = {
    execute: jest.fn(async (sql: string, params: Record<string, unknown>) => {
      statements.push({ sql, params });
      return rows(params.voterProfileIds as string[]);
    })
  };
  const repository = new NativeCompetitionRuntimeRepository(() => db as never);
  const perVoter = jest
    .spyOn(repository, 'getVoterActiveVotes')
    .mockImplementation(async (_competition, voter) => [
      { entryId: `single-${voter}`, value: 1 }
    ]);
  return { repository, statements, perVoter };
}

describe('getVotersActiveVotes', () => {
  it('reads 100 voters per statement and gives every voter its votes in order', async () => {
    const voters = Array.from({ length: 205 }, (_, index) => `voter-${index}`);
    const { repository, statements, perVoter } = repositoryWith((page) =>
      page.flatMap((voter) => [
        { voterProfileId: voter, entryId: 'b', value: 2 },
        { voterProfileId: voter, entryId: 'a', value: -1 }
      ])
    );
    const votes = await repository.getVotersActiveVotes('c', voters, {});
    expect(
      statements.map(
        ({ params }) => (params.voterProfileIds as string[]).length
      )
    ).toEqual([IN_LIST_MAX_VALUES, IN_LIST_MAX_VALUES, 5]);
    expect(votes.size).toBe(205);
    expect(votes.get('voter-204')).toEqual([
      { entryId: 'b', value: 2 },
      { entryId: 'a', value: -1 }
    ]);
    expect(perVoter).not.toHaveBeenCalled();
  });

  it('keeps every statement below the proxy pin size, even for the longest voter ids', async () => {
    // voter_profile_id is varchar(100). Quote-heavy multi-byte ids escape to
    // the most bytes: 100 of them would make a 20+ KB statement.
    const voters = Array.from(
      { length: 2 * IN_LIST_MAX_VALUES },
      (_, index) => `${index}`.padStart(4, '0') + "é'".repeat(48)
    );
    const { repository, statements } = repositoryWith(() => []);
    await repository.getVotersActiveVotes('c'.repeat(100), voters, {});
    expect(statements.length).toBeGreaterThan(2);
    expect(
      statements.flatMap(({ params }) => params.voterProfileIds as string[])
    ).toEqual(voters);
    for (const { sql, params } of statements)
      expect(
        Buffer.byteLength(formatted(sql, params), 'utf8')
      ).toBeLessThanOrEqual(PROXY_PIN_STATEMENT_BYTES);
  });

  it('keeps a full page of ordinary profile ids in one statement', async () => {
    const voters = Array.from({ length: IN_LIST_MAX_VALUES }, (_, index) =>
      `${index}`.padStart(36, 'f')
    );
    const { repository, statements } = repositoryWith(() => []);
    await repository.getVotersActiveVotes('c', voters, {});
    expect(statements).toHaveLength(1);
  });

  it('gives a voter with no active votes an empty list', async () => {
    const { repository } = repositoryWith(() => []);
    const votes = await repository.getVotersActiveVotes('c', ['quiet'], {});
    expect(votes.get('quiet')).toEqual([]);
  });

  it('reads a page voter by voter when a row names a voter not exactly as requested', async () => {
    // 'Voter-1' equals 'voter-1' only under the column collation.
    const { repository, perVoter } = repositoryWith(() => [
      { voterProfileId: 'Voter-1', entryId: 'x', value: 1 }
    ]);
    const votes = await repository.getVotersActiveVotes(
      'c',
      ['voter-1', 'voter-2'],
      {}
    );
    expect(perVoter.mock.calls.map(([, voter]) => voter)).toEqual([
      'voter-1',
      'voter-2'
    ]);
    expect(votes.get('voter-1')).toEqual([
      { entryId: 'single-voter-1', value: 1 }
    ]);
  });

  it('does not query for no voters', async () => {
    const { repository, statements } = repositoryWith(() => []);
    expect((await repository.getVotersActiveVotes('c', [], {})).size).toBe(0);
    expect(statements).toHaveLength(0);
  });
});
