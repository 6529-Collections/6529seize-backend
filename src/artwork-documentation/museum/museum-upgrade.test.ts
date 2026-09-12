import { publicationUpgradeRequiresAsset } from './museum-upgrade';

describe('released upload tombstone compatibility', () => {
  it.each(['cancelled', 'expired'])(
    'accepts exact numeric and raw MySQL BIGINT zero for %s receipts',
    (state) => {
      for (const referenced of [false, 0, '0'])
        for (const reserved_bytes of [0, '0'])
          expect(
            publicationUpgradeRequiresAsset({
              state,
              referenced,
              reserved_bytes
            })
          ).toBe(false);
    }
  );
  it.each([undefined, null, false, '', ' ', '00', '0.0', '-0', 1, '1'])(
    'retains the blocker for ambiguous or unreleased reservation %p',
    (reserved_bytes) => {
      expect(
        publicationUpgradeRequiresAsset({
          state: 'cancelled',
          referenced: false,
          reserved_bytes: reserved_bytes as number | string | undefined
        })
      ).toBe(true);
    }
  );
  it('never drops active or referenced rows even when reservations are released', () => {
    expect(
      publicationUpgradeRequiresAsset({
        state: 'ready',
        referenced: false,
        reserved_bytes: '0'
      })
    ).toBe(true);
    for (const referenced of [true, 1, '1', '', undefined])
      expect(
        publicationUpgradeRequiresAsset({
          state: 'expired',
          referenced,
          reserved_bytes: '0'
        })
      ).toBe(true);
  });
});
