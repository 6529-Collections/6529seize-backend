import { buildConsolidationKey } from '../helpers';

describe('buildConsolidationKey – deterministic matrix', () => {
  it.each([
    [['0xDef', '0xabc', '0x123'], '0x123-0xabc-0xdef'],
    [['0x1', '0x2', '0x3'], '0x1-0x2-0x3'],
    [['0xABC', '0xabc'], '0xabc-0xabc'], // duplicates kept
    [['0x1'], '0x1'],
    [[], ''],
    [['hello', 'World', '1'], '1-hello-world']
  ])('buildConsolidationKey(%j) → %s', (input: string[], expected: string) => {
    expect(buildConsolidationKey([...input])).toBe(expected);
  });

  it('single element has no hyphen', () => {
    const out = buildConsolidationKey(['0x1']);
    expect(out).toBe('0x1');
    expect(out.includes('-')).toBe(false);
  });
});

describe('buildConsolidationKey – other behaviors', () => {
  it('original input array is not mutated', () => {
    const input = ['0xB', '0xA'];
    const copy = [...input];
    buildConsolidationKey(input);
    expect(input).toEqual(copy);
  });

  it('undefined or null throws TypeError', () => {
    expect(() => buildConsolidationKey(undefined as any)).toThrow(TypeError);
    expect(() => buildConsolidationKey(null as any)).toThrow(TypeError);
  });
});

describe('buildConsolidationKey – performance', () => {
  it('handles very large inputs', () => {
    const bigArr = Array.from({ length: 100000 }, (_, i) => `0x${i}`);
    expect(() => buildConsolidationKey(bigArr)).not.toThrow();
  });
});
