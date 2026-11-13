import * as fc from 'fast-check';
import {
  CONSOLIDATION_DISPLAY_MAX_LENGTH,
  formatConsolidationDisplay,
  shortFormatIfAddress
} from './consolidation-display';

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

describe('formatConsolidationDisplay', () => {
  it('returns a single wallet display unchanged', () => {
    expect(
      formatConsolidationDisplay([{ wallet: wallet(1), display: wallet(1) }])
    ).toBe(wallet(1));
    expect(
      formatConsolidationDisplay([
        { wallet: wallet(1), display: 'punk6529.eth' }
      ])
    ).toBe('punk6529.eth');
  });

  it('joins names and shortens bare addresses, as before', () => {
    expect(
      formatConsolidationDisplay([
        { wallet: wallet(1), display: 'vault.eth' },
        { wallet: wallet(2), display: wallet(2) }
      ])
    ).toBe(`vault.eth - ${shortFormatIfAddress(wallet(2))}`);
  });

  it('replaces the longest names with short addresses until it fits', () => {
    // Four 150-character names join to 609 characters; shortening one is enough.
    const long = (c: string) => `${c.repeat(146)}.eth`;
    const result = formatConsolidationDisplay([
      { wallet: wallet(1), display: long('a') },
      { wallet: wallet(2), display: long('b') },
      { wallet: wallet(3), display: long('c') },
      { wallet: wallet(4), display: long('d') }
    ]);
    expect(result.length).toBeLessThanOrEqual(CONSOLIDATION_DISPLAY_MAX_LENGTH);
    expect(result).toBe(
      [shortFormatIfAddress(wallet(1)), long('b'), long('c'), long('d')].join(
        ' - '
      )
    );
  });

  it('always fits the column and changes nothing when it already fits', () => {
    const name = fc
      .string({ minLength: 1, maxLength: 146 })
      .filter((s) => !s.includes('?'))
      .map((s) => `${s}.eth`);
    fc.assert(
      fc.property(
        fc.array(name, { minLength: 2, maxLength: 4 }),
        (displays) => {
          const parts = displays.map((display, i) => ({
            wallet: wallet(i + 1),
            display
          }));
          const unchanged = displays.join(' - ');
          const result = formatConsolidationDisplay(parts);
          expect(result.length).toBeLessThanOrEqual(
            CONSOLIDATION_DISPLAY_MAX_LENGTH
          );
          if (unchanged.length <= CONSOLIDATION_DISPLAY_MAX_LENGTH) {
            expect(result).toBe(unchanged);
          }
        }
      ),
      { numRuns: 500 }
    );
  });
});
