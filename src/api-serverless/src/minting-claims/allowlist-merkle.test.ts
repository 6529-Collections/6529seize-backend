import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { computeAllowlistMerkle } from './allowlist-merkle';

function sumAmountsByAddress(
  entries: Array<{ address: string; amount: number }>
) {
  const map = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.address.toLowerCase();
    map.set(key, (map.get(key) ?? 0) + entry.amount);
  }
  return map;
}

describe('computeAllowlistMerkle', () => {
  it('is deterministic regardless of input ordering', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            address: fc
              .hexaString({ minLength: 40, maxLength: 40 })
              .map((hex) => `0x${hex}`),
            amount: fc.integer({ min: 1, max: 5 })
          }),
          { minLength: 1, maxLength: 50 }
        ),
        (entries) => {
          const resultA = computeAllowlistMerkle(entries);
          const resultB = computeAllowlistMerkle([...entries].reverse());
          expect(resultA.merkleRoot).toBe(resultB.merkleRoot);
          expect(resultA.proofsByAddress).toEqual(resultB.proofsByAddress);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('returns one proof item per allowed spot with unique indices', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            address: fc
              .hexaString({ minLength: 40, maxLength: 40 })
              .map((hex) => `0x${hex}`),
            amount: fc.integer({ min: 1, max: 5 })
          }),
          { minLength: 1, maxLength: 25 }
        ),
        (entries) => {
          const result = computeAllowlistMerkle(entries);
          expect(result.merkleRoot).toMatch(/^0x[a-fA-F0-9]{64}$/);

          const totals = sumAmountsByAddress(entries);
          for (const [address, total] of Array.from(totals.entries())) {
            expect(result.proofsByAddress[address]).toHaveLength(total);
          }

          const allValues = Object.values(result.proofsByAddress)
            .flat()
            .map((proof) => proof.value);
          const totalLeaves = Array.from(totals.values()).reduce(
            (a, b) => a + b,
            0
          );
          expect(allValues).toHaveLength(totalLeaves);
          const unique = new Set(allValues);
          expect(unique.size).toBe(totalLeaves);
          expect(Math.min(...allValues)).toBe(0);
          expect(Math.max(...allValues)).toBe(totalLeaves - 1);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('throws on invalid addresses', () => {
    expect(() =>
      computeAllowlistMerkle([{ address: 'not-an-address', amount: 1 }])
    ).toThrow(/Invalid allowlist address/);
  });
});
