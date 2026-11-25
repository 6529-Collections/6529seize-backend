import * as fc from 'fast-check';
import { compareOrderKeys, RecordOrderKey } from './record-order';
import { hexBytes, VECTORS } from './record-test-fixtures';
import {
  openSealedItems,
  SealedClass,
  SealedItem,
  sealItems
} from './sealed-crypto';

const PV_WAVE = VECTORS.sealedSettings.event.wave;
const senderKey = hexBytes(VECTORS.inputs.senderKey);

const orderKey: fc.Arbitrary<RecordOrderKey> = fc.record({
  anchor: fc.integer({ min: 0, max: 5 }),
  claimedTime: fc.integer({ min: 0, max: 5 }),
  eventId: fc.constantFrom(
    `0x${'0'.repeat(64)}`,
    `0x${'a'.repeat(64)}`,
    `0x${'f'.repeat(64)}`
  )
});

const item: fc.Arbitrary<SealedItem> = fc.record({
  t: fc.stringMatching(/^[a-z0-9.-]{1,32}$/),
  k: fc.string({ maxLength: 50 }),
  b: fc.option(
    fc.dictionary(
      fc.stringMatching(/^[a-z]{1,8}$/),
      fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.boolean())
    ),
    { nil: null }
  )
});

describe('properties', () => {
  it('orders records totally: antisymmetric and transitive', () => {
    fc.assert(
      fc.property(orderKey, orderKey, orderKey, (a, b, c) => {
        // Opposite signs, or both zero.
        expect(
          Math.sign(compareOrderKeys(a, b)) + Math.sign(compareOrderKeys(b, a))
        ).toBe(0);
        if (compareOrderKeys(a, b) <= 0 && compareOrderKeys(b, c) <= 0) {
          expect(compareOrderKeys(a, c)).toBeLessThanOrEqual(0);
        }
      })
    );
  });

  it('opens what it seals, for any items', () => {
    fc.assert(
      fc.property(
        fc.array(item, { minLength: 1, maxLength: 8 }),
        fc.constantFrom(SealedClass.PROVIDER, SealedClass.OWN),
        fc.integer({ min: 1, max: 0xffffffff }),
        (items, cls, gen) => {
          const bytes = sealItems({
            wave: PV_WAVE,
            cls,
            gen,
            deviceKey: VECTORS.inputs.deviceKey,
            senderKey,
            items
          });
          const opened = openSealedItems({ wave: PV_WAVE, bytes, senderKey });
          expect(opened.cls).toBe(cls);
          expect(opened.gen).toBe(gen);
          expect(opened.items).toEqual(
            items.map(({ t, k, b }) => ({ t, k, b }))
          );
        }
      ),
      { numRuns: 50 }
    );
  });
});
