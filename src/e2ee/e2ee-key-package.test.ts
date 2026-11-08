import * as fc from 'fast-check';
import { readE2eeKeyPackageCiphersuite } from '@/e2ee/e2ee-key-package';

describe('readE2eeKeyPackageCiphersuite', () => {
  it('reads the suite after the mls10 version', () => {
    expect(
      readE2eeKeyPackageCiphersuite(Buffer.from([0x00, 0x01, 0x00, 0x4f, 0x20]))
    ).toBe(0x004f);
    expect(
      readE2eeKeyPackageCiphersuite(Buffer.from([0x00, 0x01, 0x00, 0x4e]))
    ).toBe(0x004e);
  });

  it('refuses bytes that are not an MLS 1.0 KeyPackage', () => {
    expect(readE2eeKeyPackageCiphersuite(Buffer.alloc(0))).toBeNull();
    expect(
      readE2eeKeyPackageCiphersuite(Buffer.from([0x00, 0x01, 0x00]))
    ).toBeNull();
    expect(
      readE2eeKeyPackageCiphersuite(Buffer.from([0x00, 0x02, 0x00, 0x4f]))
    ).toBeNull();
    expect(
      readE2eeKeyPackageCiphersuite(Buffer.from('kp-not-mls'))
    ).toBeNull();
  });

  it('returns any uint16 suite that follows the version', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff }),
        fc.uint8Array({ maxLength: 64 }),
        (suite, rest) => {
          const data = Buffer.concat([
            Buffer.from([0x00, 0x01, suite >> 8, suite & 0xff]),
            Buffer.from(rest)
          ]);
          expect(readE2eeKeyPackageCiphersuite(data)).toBe(suite);
        }
      )
    );
  });
});
