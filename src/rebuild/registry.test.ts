import * as path from 'node:path';
import { AREA_MANIFESTS } from '@/rebuild/manifests';
import { checkRegistry } from '@/rebuild/registry-check';
import { stepCodeIn } from '@/rebuild/step-code';
import { discoverCodeTables } from '@/rebuild/table-discovery';

// The rebuild check's table registry: every table and view code knows sits
// in exactly one area manifest. A new entity or table constant fails here
// until its area classifies it (see docs/rebuild-check.md).
describe('rebuild registry', () => {
  const codeTables = discoverCodeTables();
  // As a run checks it: a planned step whose module isn't in this tree
  // yet is left out of the order checks on its writes.
  const result = checkRegistry({
    manifests: AREA_MANIFESTS,
    codeTables,
    stepCodeHere: stepCodeIn(path.resolve(__dirname, '..', '..'))
  });

  it('classifies every table once, with well-formed steps and probes', () => {
    expect(result.problems).toEqual([]);
  });

  it('finds the entity, constant, retired and view names', () => {
    const origins = new Set(
      Array.from(codeTables.values()).flatMap((set) => Array.from(set))
    );
    expect(Array.from(origins).sort((a, b) => a.localeCompare(b))).toEqual([
      'constant',
      'entity',
      'retired',
      'view'
    ]);
    expect(codeTables.get('identities')?.has('entity')).toBe(true);
    expect(codeTables.get('drop_ranks')?.has('retired')).toBe(true);
    expect(codeTables.get('legacy_get_drops')?.has('view')).toBe(true);
  });
});
