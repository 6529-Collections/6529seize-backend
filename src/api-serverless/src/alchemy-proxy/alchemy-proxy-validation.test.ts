import fc from 'fast-check';
import {
  tokenMetadataCacheKey,
  tokenMetadataRequestSchema
} from './alchemy-proxy.validation';

const ADDRESS = '0x0000000000000000000000000000000000000001';

describe('tokenMetadataCacheKey', () => {
  it('has a fixed length regardless of the request size', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat().map(String), { maxLength: 100 }),
        (tokenIds) => {
          const key = tokenMetadataCacheKey({
            address: ADDRESS,
            tokenIds,
            chain: 'ethereum'
          });
          expect(key).toMatch(/^alchemy-token-metadata:[0-9a-f]{64}$/);
        }
      )
    );
  });

  it('ignores body fields the handler does not read', () => {
    const base = { address: ADDRESS, tokenIds: ['1'] };
    const a = tokenMetadataRequestSchema.validate(base).value;
    const b = tokenMetadataRequestSchema.validate({
      ...base,
      unrelated: 'x'.repeat(1000)
    }).value;
    expect(tokenMetadataCacheKey(a)).toBe(tokenMetadataCacheKey(b));
  });

  it('treats numeric and string token ids alike', () => {
    const a = tokenMetadataRequestSchema.validate({
      address: ADDRESS,
      tokenIds: [1]
    }).value;
    const b = tokenMetadataRequestSchema.validate({
      address: ADDRESS,
      tokenIds: ['1']
    }).value;
    expect(a?.tokenIds).toEqual(['1']);
    expect(tokenMetadataCacheKey(a)).toBe(tokenMetadataCacheKey(b));
  });

  it('distinguishes different requests', () => {
    const key = (tokenIds: string[]) =>
      tokenMetadataCacheKey({ address: ADDRESS, tokenIds, chain: 'ethereum' });
    expect(key(['1'])).not.toBe(key(['2']));
    expect(key(['1', '2'])).not.toBe(key(['2', '1']));
  });

  it('returns null without a validated request', () => {
    expect(tokenMetadataCacheKey(undefined)).toBeNull();
  });
});
