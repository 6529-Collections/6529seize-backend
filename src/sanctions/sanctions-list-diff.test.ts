import { diffSanctionsLists } from '@/sanctions/sanctions-list-diff';
import type {
  SanctionsListing,
  SanctionsListV1,
  SanctionsSourceId
} from '@/sanctions/sanctions-list.types';

function listing(source: SanctionsSourceId): SanctionsListing {
  return {
    source,
    entry_id: '1',
    entity: null,
    programs: [],
    labels: [],
    listed_on: null,
    valid_until: null
  };
}

function list(entries: Array<[string, SanctionsSourceId[]]>): SanctionsListV1 {
  return {
    schema: '6529.sanctions-list.v1',
    builder: '6529-sanctions-builder/1',
    chain_family: 'evm',
    sources: [],
    addresses: entries.map(([address, sources]) => ({
      address,
      listings: sources.map(listing)
    })),
    totals: { addresses: entries.length, listings: 0, sources: 0 }
  };
}

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const C = `0x${'c'.repeat(40)}`;

describe('diffSanctionsLists', () => {
  it('reports additions and removals overall and per source', () => {
    const previous = list([
      [A, ['us-ofac-sdn']],
      [B, ['uk-fcdo']]
    ]);
    const next = list([
      [A, ['us-ofac-sdn', 'jp-mof']],
      [C, ['eu-fsf']]
    ]);
    expect(diffSanctionsLists(previous, next)).toEqual({
      added: [C],
      removed: [B],
      by_source: [
        { source: 'eu-fsf', added: [C], removed: [] },
        { source: 'jp-mof', added: [A], removed: [] },
        { source: 'uk-fcdo', added: [], removed: [B] }
      ]
    });
  });

  it('is empty for identical lists', () => {
    const same = list([[A, ['us-ofac-sdn']]]);
    expect(diffSanctionsLists(same, same)).toEqual({
      added: [],
      removed: [],
      by_source: []
    });
  });
});
