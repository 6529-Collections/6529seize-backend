import { ConsolidatedTDH } from '@/entities/ITDH';
import { getConsolidationWallets } from './consolidation-wallets';

function consolidation(
  wallets: unknown,
  consolidationKey = 'a-b'
): Pick<ConsolidatedTDH, 'consolidation_key' | 'wallets'> {
  return {
    consolidation_key: consolidationKey,
    wallets
  };
}

describe('getConsolidationWallets', () => {
  it('returns a native string array', () => {
    expect(getConsolidationWallets(consolidation(['a', 'b']))).toEqual([
      'a',
      'b'
    ]);
  });

  it('parses a JSON-encoded string array', () => {
    expect(
      getConsolidationWallets(consolidation(JSON.stringify(['a', 'b'])))
    ).toEqual(['a', 'b']);
  });

  it.each([
    ['malformed JSON', 'not-json'],
    ['non-string native array', ['a', null]],
    ['non-string JSON array', JSON.stringify(['a', null])],
    ['non-array value', null]
  ])('falls back to the consolidation key for %s', (_, wallets) => {
    expect(getConsolidationWallets(consolidation(wallets, 'c-d'))).toEqual([
      'c',
      'd'
    ]);
  });
});
