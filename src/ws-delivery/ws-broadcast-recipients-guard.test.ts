import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Every query that selects broadcast recipients from `ws_connections` must
 * leave typing-purpose sockets out (waves 0.12a). A raw all-connections
 * query in the NFT-link refresher once sent 179 MEDIA_LINK_UPDATED frames to
 * one typing socket in three minutes; this guard fails for any such query.
 *
 * A statement is exempt when it writes (insert/update/delete), targets one
 * known connection (`connection_id = :connectionId`, this exact parameter
 * name), or is explicitly marked `/* not a broadcast audience *\/` in its SQL.
 * Every other statement must interpolate the purpose filter, and the alias
 * the filter uses must be the connections table's alias in that statement.
 */
const SRC = path.resolve(__dirname, '..');
const TABLE_TOKEN = '${WS_CONNECTIONS_TABLE}';
const EXEMPT_MARKER = '/* not a broadcast audience */';
const FILTER_CALL =
  /\$\{\s*(?:\w+\.)?(?:broadcastPurposeFilterSql|purposeFilterSql)\(([^)]*)\)\s*\}/g;

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

/**
 * The raw text of every top-level template literal in `source`, with nested
 * `${...}` expressions and nested templates kept inside their outer literal.
 * Quoted strings and comments are skipped so their backticks do not count.
 */
function templateLiterals(source: string): string[] {
  const n = source.length;
  const skipQuoted = (start: number): number => {
    const quote = source[start];
    let j = start + 1;
    while (j < n) {
      const c = source[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === quote || c === '\n') return j + 1;
      j++;
    }
    return n;
  };
  const skipExpression = (start: number): number => {
    let depth = 1;
    let j = start;
    while (j < n && depth > 0) {
      const c = source[j];
      if (c === '`') {
        j = skipTemplate(j);
        continue;
      }
      if (c === "'" || c === '"') {
        j = skipQuoted(j);
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      j++;
    }
    return j;
  };
  const skipTemplate = (start: number): number => {
    let j = start + 1;
    while (j < n) {
      const c = source[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`') return j + 1;
      if (c === '$' && source[j + 1] === '{') {
        j = skipExpression(j + 2);
        continue;
      }
      j++;
    }
    return n;
  };

  const literals: string[] = [];
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? n : end + 1;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'" || c === '"') {
      i = skipQuoted(i);
    } else if (c === '`') {
      const end = skipTemplate(i);
      literals.push(source.slice(i + 1, end - 1));
      i = end;
    } else {
      i++;
    }
  }
  return literals;
}

function connectionQueries(source: string): string[] {
  return templateLiterals(source).filter((sql) => sql.includes(TABLE_TOKEN));
}

function isExempt(sql: string): boolean {
  const statement = sql.trim().toLowerCase();
  return (
    /^(insert|update|delete)\b/.test(statement) ||
    /connection_id\s*=\s*:connectionid\b/.test(statement) ||
    sql.includes(EXEMPT_MARKER)
  );
}

/** Aliases the interpolated filter calls refer to (`ws` by default). */
function filterAliases(sql: string): string[] {
  const aliases: string[] = [];
  const calls = new RegExp(FILTER_CALL.source, 'g');
  for (let call = calls.exec(sql); call; call = calls.exec(sql)) {
    const quoted = /['"](\w+)['"]\s*$/.exec(call[1].trim());
    aliases.push(quoted ? quoted[1] : 'ws');
  }
  return aliases;
}

/** Problems with one recipient query, or none. */
function problems(sql: string): string[] {
  if (isExempt(sql)) return [];
  const aliases = filterAliases(sql);
  if (!aliases.length) return ['no purpose filter'];
  return aliases
    .filter(
      (alias) =>
        !new RegExp(
          `\\$\\{WS_CONNECTIONS_TABLE\\}\\s+(?:as\\s+)?${alias}\\b`,
          'i'
        ).test(sql)
    )
    .map((alias) => `filter alias "${alias}" is not a connections alias`);
}

describe('broadcast recipient queries leave typing sockets out', () => {
  const files = sourceFiles(SRC).filter((file) =>
    readFileSync(file, 'utf8').includes(TABLE_TOKEN)
  );
  const relativePath = (file: string) =>
    path.relative(SRC, file).split(path.sep).join('/');

  it('finds the known recipient sources and queries', () => {
    expect(files.map(relativePath)).toEqual(
      expect.arrayContaining([
        'api-serverless/src/ws/ws-connection.repository.ts',
        'nftLinkRefresherLoop/nft-link-refresh-notifier.db.ts'
      ])
    );
    const repository = connectionQueries(
      readFileSync(
        path.join(SRC, 'api-serverless/src/ws/ws-connection.repository.ts'),
        'utf8'
      )
    );
    const byWave = repository.filter((sql) =>
      /select \* from \$\{WS_CONNECTIONS_TABLE\} ws\s+where wave_id = :waveId/.test(
        sql
      )
    );
    expect(byWave).toHaveLength(1);
    expect(isExempt(byWave[0])).toBe(false);
  });

  it.each(files.map((file) => [relativePath(file)]))(
    '%s filters typing-purpose sockets from every audience',
    (relative) => {
      const source = readFileSync(path.join(SRC, relative), 'utf8');
      const found = connectionQueries(source)
        .map((sql) => ({
          sql: sql.trim().slice(0, 160),
          problems: problems(sql)
        }))
        .filter((query) => query.problems.length);
      expect(found).toEqual([]);
    }
  );

  describe('self-checks', () => {
    it('flags an all-connections query without the filter', () => {
      const [sql] = connectionQueries(
        'execute(`select connection_id from ${WS_CONNECTIONS_TABLE} where jwt_expiry > unix_timestamp()`)'
      );
      expect(problems(sql)).toEqual(['no purpose filter']);
    });

    it('does not accept a filter that is only mentioned, not interpolated', () => {
      const [sql] = connectionQueries(
        'execute(`select connection_id from ${WS_CONNECTIONS_TABLE} ws -- purposeFilterSql() later\n`)'
      );
      expect(problems(sql)).toEqual(['no purpose filter']);
    });

    it('flags a filter whose alias the query does not define', () => {
      const [sql] = connectionQueries(
        'execute(`select connection_id from ${WS_CONNECTIONS_TABLE} where ${purposeFilterSql()}`)'
      );
      expect(problems(sql)).toEqual([
        'filter alias "ws" is not a connections alias'
      ]);
      const [aliased] = connectionQueries(
        "execute(`select 1 from x join ${WS_CONNECTIONS_TABLE} connections on 1 where ${purposeFilterSql({}, 'connections')}`)"
      );
      expect(problems(aliased)).toEqual([]);
    });

    it('keeps a query with nested templates and two table references whole', () => {
      const queries = connectionQueries(
        [
          "const s = 'a ` quote'; // and a ` comment",
          'execute(`select c from ${WS_CONNECTIONS_TABLE} ws',
          '  where ${flag ? `x = ${`y`}` : "1"}',
          '  and c in (select c from ${WS_CONNECTIONS_TABLE} other)`);'
        ].join('\n')
      );
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain('other)');
      expect(problems(queries[0])).toEqual(['no purpose filter']);
    });
  });
});
