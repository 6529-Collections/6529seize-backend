import { stableCacheHash } from './wave-cache-key';

describe('stableCacheHash', () => {
  it('ignores object key ordering and undefined values', () => {
    expect(
      stableCacheHash({
        b: 2,
        a: 1,
        ignored: undefined
      })
    ).toEqual(
      stableCacheHash({
        a: 1,
        b: 2
      })
    );
  });

  it('serializes dates consistently', () => {
    expect(stableCacheHash({ updatedAt: new Date(1700000000000) })).toEqual(
      stableCacheHash({ updatedAt: '2023-11-14T22:13:20.000Z' })
    );
  });
});
