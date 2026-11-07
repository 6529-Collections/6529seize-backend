import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Every query that selects broadcast recipients from `ws_connections` must
 * leave typing-purpose sockets out (waves 0.12a). A raw all-connections
 * query in the NFT-link refresher once sent 179 MEDIA_LINK_UPDATED frames to
 * one typing socket in three minutes; this guard fails for any such query.
 *
 * A statement is exempt when it writes (insert/update/delete), targets one
 * known connection (`connection_id = :connectionId`), or is explicitly
 * marked `/* not a broadcast audience *\/` in its SQL text.
 */
const SRC = path.resolve(__dirname, '..');
const TABLE_TOKEN = '${WS_CONNECTIONS_TABLE}';
const EXEMPT_MARKER = '/* not a broadcast audience */';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return ['node_modules', 'generated', 'dist', 'tests'].includes(name)
        ? []
        : sourceFiles(full);
    }
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

/** Template literals (top level only) that mention the connections table. */
function connectionQueries(source: string): string[] {
  const queries: string[] = [];
  let index = source.indexOf(TABLE_TOKEN);
  while (index >= 0) {
    const start = source.lastIndexOf('`', index);
    const end = source.indexOf('`', index);
    if (start >= 0 && end > start) queries.push(source.slice(start + 1, end));
    index = source.indexOf(TABLE_TOKEN, end >= 0 ? end : index + 1);
  }
  return queries;
}

function isExempt(sql: string): boolean {
  const statement = sql.trim().toLowerCase();
  return (
    /^(insert|update|delete)\b/.test(statement) ||
    /connection_id\s*=\s*:connectionid\b/.test(statement) ||
    sql.includes(EXEMPT_MARKER)
  );
}

describe('broadcast recipient queries leave typing sockets out', () => {
  const files = sourceFiles(SRC).filter((file) =>
    readFileSync(file, 'utf8').includes(TABLE_TOKEN)
  );

  it('finds the known recipient sources', () => {
    const relative = files.map((file) =>
      path.relative(SRC, file).split(path.sep).join('/')
    );
    expect(relative).toEqual(
      expect.arrayContaining([
        'api-serverless/src/ws/ws-connection.repository.ts',
        'nftLinkRefresherLoop/nft-link-refresh-notifier.db.ts'
      ])
    );
  });

  it.each(
    files.map((file) => [path.relative(SRC, file).split(path.sep).join('/')])
  )('%s filters typing-purpose sockets from every audience', (relative) => {
    const source = readFileSync(path.join(SRC, relative), 'utf8');
    const unfiltered = connectionQueries(source).filter(
      (sql) => !isExempt(sql) && !/purposeFilterSql\(/i.test(sql)
    );
    expect(unfiltered).toEqual([]);
  });

  it('would flag an all-connections query without the filter', () => {
    const offending = connectionQueries(
      'execute(`select connection_id from ${WS_CONNECTIONS_TABLE} where jwt_expiry > unix_timestamp()`)'
    );
    expect(offending).toHaveLength(1);
    expect(isExempt(offending[0])).toBe(false);
    expect(/purposeFilterSql\(/i.test(offending[0])).toBe(false);
  });
});
