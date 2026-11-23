import { RebuildStep } from '@/rebuild/manifest.types';
import { refusalsIn } from '@/rebuild/run/refusals';

function step(writes: RebuildStep['writes']): RebuildStep {
  return {
    id: 'a.step',
    run: { module: 'src/x', exportName: 'run' },
    writes,
    sources: ['repo'],
    timeoutMinutes: 5
  };
}

// MySQL 8.0.46's own texts, errors 1143 and 1142.
const LOG = [
  "ERROR 1143 (42000): INSERT command denied to user 'rw'@'localhost' for column 'tdh' in table 'ident'",
  "ERROR 1143 (42000): UPDATE command denied to user 'ow'@'localhost' for column 'name' in table 'ident'",
  "ERROR 1142 (42000): INSERT command denied to user 'rw'@'localhost' for table 'other'",
  "ERROR 1142 (42000): DELETE command denied to user 'ow'@'localhost' for table 'ident'",
  "ERROR 1142 (42000): INSERT, DELETE command denied to user 'ow'@'localhost' for table 'ident'"
].join('\n');

describe('refusals in a step log', () => {
  it("names a column owner's refusals: another column, rows, a table it doesn't write", () => {
    const owner = step([
      { table: 'ident', columns: ['tdh', 'basetdh_rate'], reason: 'x' }
    ]);
    expect(refusalsIn(owner, LOG)).toEqual([
      'a.step may not INSERT column tdh of ident: it owns only tdh, basetdh_rate there',
      'a.step may not UPDATE column name of ident: it owns only tdh, basetdh_rate there',
      "a.step may not INSERT other: the table isn't in its writes",
      'a.step may not DELETE ident: it owns only columns there',
      'a.step may not INSERT, DELETE ident: it owns only columns there'
    ]);
  });

  it("names a row writer's refusal of an owned column, and of its own table", () => {
    const rows = step(['ident', 'other']);
    expect(refusalsIn(rows, LOG)).toEqual([
      'a.step may not INSERT column tdh of ident: a column owner owns it',
      'a.step may not UPDATE column name of ident: a column owner owns it',
      'a.step may not INSERT other: its grants on the table refuse it',
      'a.step may not DELETE ident: its grants on the table refuse it',
      'a.step may not INSERT, DELETE ident: its grants on the table refuse it'
    ]);
  });

  it('finds nothing in a log without refusals', () => {
    expect(refusalsIn(step(['ident']), 'ok\n')).toEqual([]);
  });
});
