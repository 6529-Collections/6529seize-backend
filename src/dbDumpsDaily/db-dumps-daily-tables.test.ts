import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_DUMPS_DAILY_TABLES } from './db-dumps-daily-tables';

// D146: daily dumps must never carry DM or other private content. Adding a
// table here is a deliberate, reviewed change to this list and this test.
const ALLOWED = ['transactions', 'delegations', 'consolidations'];

describe('dbDumpsDaily tables', () => {
  it('dumps only the reviewed public chain tables', () => {
    expect(
      [...DB_DUMPS_DAILY_TABLES].sort((a, b) => a.localeCompare(b))
    ).toEqual([...ALLOWED].sort((a, b) => a.localeCompare(b)));
  });

  it('dumps no table through any other path', () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    const queried = Array.from(source.matchAll(/FROM \$\{(\w+)\}/g)).map(
      (m) => m[1]
    );
    expect(queried.sort((a, b) => a.localeCompare(b))).toEqual([
      'NFTDELEGATION_BLOCKS_TABLE',
      'tableName'
    ]);
  });
});
