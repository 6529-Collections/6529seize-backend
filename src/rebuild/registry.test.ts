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

  it('leaves out of the order checks only the planned rebuilders listed here', () => {
    // A module that lands, moves or goes changes this list: the order
    // checks then cover its writes.
    expect(result.orderLeftOut).toEqual([
      {
        step: 'holdings.ethereum',
        tables: [
          'transactions',
          'transfer_reconciliations',
          'nft_owners',
          'nft_owners_consolidation',
          'nft_owners_sync_state',
          'nfts',
          'nfts_meme_lab',
          'memes_extended_data',
          'lab_extended_data',
          'memes_seasons',
          'artists',
          'nfts_history',
          'nfts_history_events',
          'nfts_history_claims',
          'nfts_history_blocks',
          'aggregated_activity',
          'aggregated_activity_memes',
          'aggregated_activity_consolidation',
          'aggregated_activity_memes_consolidation',
          'owners_balances',
          'owners_balances_memes',
          'owners_balances_consolidation',
          'owners_balances_memes_consolidation',
          'meme_lab_royalties'
        ]
      }
    ]);
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
