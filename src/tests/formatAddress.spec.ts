import { formatAddress } from '../helpers';

describe('formatAddress', () => {
  it('formats a standard hex address', () => {
    const addr = '0x1234567890123456789012345678901234567890';
    expect(formatAddress(addr)).toBe('0x123...890');
  });

  it('does not modify ENS names', () => {
    expect(formatAddress('vitalik.eth')).toBe('vitalik.eth');
  });

  it('does not format strings without 0x prefix', () => {
    expect(formatAddress('123456')).toBe('123456');
  });

  it('returns the value when address is undefined or null', () => {
    expect(formatAddress(undefined as any)).toBeUndefined();
    expect(formatAddress(null as any)).toBeNull();
  });

  it('returns input when empty', () => {
    expect(formatAddress('')).toBe('');
  });

  it('ignores addresses with uppercase 0X prefix', () => {
    expect(formatAddress('0XABCDEF')).toBe('0XABCDEF');
  });

  it('uses first five and last three characters', () => {
    const addr = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const formatted = formatAddress(addr);
    expect(formatted.startsWith(addr.substring(0, 5))).toBe(true);
    expect(formatted.endsWith(addr.substring(addr.length - 3))).toBe(true);
  });
});
