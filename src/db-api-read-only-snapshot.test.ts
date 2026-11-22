import { inReadOnlySnapshot } from './db-api';

function connection(failOn?: string) {
  const sql: string[] = [];
  return {
    sql,
    query: (text: string, done: (err: unknown) => void) => {
      sql.push(text);
      done(failOn && text.startsWith(failOn) ? new Error(failOn) : null);
    }
  };
}

describe('inReadOnlySnapshot', () => {
  it('reads in UTC inside a read-only snapshot, then gives the zone back', async () => {
    const conn = connection();
    const result = await inReadOnlySnapshot(conn as never, async () => {
      conn.sql.push('work');
      return 7;
    });
    expect(result).toBe(7);
    expect(conn.sql).toEqual([
      "SET time_zone = '+00:00'",
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
      'work',
      'ROLLBACK',
      'SET time_zone = DEFAULT'
    ]);
  });

  it('rolls back and gives the zone back when the work fails', async () => {
    const conn = connection();
    await expect(
      inReadOnlySnapshot(conn as never, async () => {
        throw new Error('read failed');
      })
    ).rejects.toThrow('read failed');
    expect(conn.sql.slice(-2)).toEqual(['ROLLBACK', 'SET time_zone = DEFAULT']);
  });
});
