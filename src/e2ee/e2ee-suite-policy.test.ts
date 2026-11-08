import * as fc from 'fast-check';
import {
  canE2eeDeviceJoin,
  decodeE2eeSuiteSet,
  E2EE_SUITE_ALIASES,
  e2eeDeviceSuites,
  encodeE2eeSuiteSet,
  isCanonicalE2eeSuiteSet,
  isE2eeV1GrantAccepted,
  readE2eeSuiteTransition
} from '@/e2ee/e2ee-suite-policy';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 10);
const OPEN = { startMs: null, days: 14 };
const CLOSED = { startMs: NOW - 15 * DAY, days: 14 };

const v1 = (ciphersuite: number) => ({ grant_version: 1, ciphersuite });
const v2 = (suites: number[]) => ({
  grant_version: 2,
  ciphersuite: suites[0],
  ciphersuites: encodeE2eeSuiteSet(suites)
});

describe('E2EE suite policy (D172)', () => {
  describe('canonical suite sets', () => {
    it('accepts 1 to 4 strictly ascending uint16 code points', () => {
      expect(isCanonicalE2eeSuiteSet([78])).toBe(true);
      expect(isCanonicalE2eeSuiteSet([78, 79])).toBe(true);
      expect(isCanonicalE2eeSuiteSet([1, 2, 3, 65535])).toBe(true);
      for (const bad of [
        [],
        [79, 78],
        [78, 78],
        [1, 2, 3, 4, 5],
        [0],
        [65536],
        [78.5],
        ['78'],
        '78',
        null
      ]) {
        expect(isCanonicalE2eeSuiteSet(bad)).toBe(false);
      }
    });

    it('stores a set as "." joined codes and reads it back', () => {
      fc.assert(
        fc.property(
          fc
            .uniqueArray(fc.integer({ min: 1, max: 65535 }), {
              minLength: 1,
              maxLength: 4
            })
            .map((suites) => [...suites].sort((a, b) => a - b)),
          (suites) => {
            expect(decodeE2eeSuiteSet(encodeE2eeSuiteSet(suites))).toEqual(
              suites
            );
          }
        )
      );
      expect(encodeE2eeSuiteSet([78, 79])).toBe('78.79');
      for (const bad of [null, '', '79.78', '78,79', '78.', 'x']) {
        expect(decodeE2eeSuiteSet(bad)).toBeNull();
      }
    });
  });

  describe('transition window', () => {
    it('is open until a start is configured, then for the configured days', () => {
      expect(readE2eeSuiteTransition({})).toEqual({ startMs: null, days: 14 });
      expect(
        readE2eeSuiteTransition({
          E2EE_SUITE_TRANSITION_START: '2026-11-10T00:00:00Z',
          E2EE_SUITE_TRANSITION_DAYS: '7'
        })
      ).toEqual({ startMs: NOW, days: 7 });
      expect(
        readE2eeSuiteTransition({ E2EE_SUITE_TRANSITION_START: String(NOW) })
      ).toEqual({ startMs: NOW, days: 14 });
      expect(
        readE2eeSuiteTransition({
          E2EE_SUITE_TRANSITION_START: 'not a date',
          E2EE_SUITE_TRANSITION_DAYS: '-3'
        })
      ).toEqual({ startMs: null, days: 14 });

      const started = { startMs: NOW, days: 14 };
      expect(isE2eeV1GrantAccepted(NOW, OPEN)).toBe(true);
      expect(isE2eeV1GrantAccepted(NOW + 14 * DAY - 1, started)).toBe(true);
      expect(isE2eeV1GrantAccepted(NOW + 14 * DAY, started)).toBe(false);
    });
  });

  describe('device suites', () => {
    it('honours a v1 grant only for 0x004F and only while the window is open', () => {
      expect(e2eeDeviceSuites(v1(79), NOW, { transition: OPEN })).toEqual([79]);
      expect(e2eeDeviceSuites(v1(78), NOW, { transition: OPEN })).toEqual([]);
      expect(e2eeDeviceSuites(v1(79), NOW, { transition: CLOSED })).toEqual([]);
      // Rows written before grant versions existed read as v1.
      expect(
        e2eeDeviceSuites({ ciphersuite: 79 }, NOW, { transition: OPEN })
      ).toEqual([79]);
    });

    it('gives a v2 grant its accepted suites, whatever the window', () => {
      expect(e2eeDeviceSuites(v2([78]), NOW, { transition: CLOSED })).toEqual([
        78
      ]);
      expect(e2eeDeviceSuites(v2([78, 79]), NOW)).toEqual([78, 79]);
      expect(canE2eeDeviceJoin(v2([78]), 78, NOW)).toBe(true);
      expect(canE2eeDeviceJoin(v2([78]), 79, NOW)).toBe(false);
      expect(canE2eeDeviceJoin(v1(79), 78, NOW, { transition: OPEN })).toBe(
        false
      );
    });

    it('lets an unaccepted suite in a signed set grant nothing until the server accepts it', () => {
      const device = v2([78, 4660]);
      expect(e2eeDeviceSuites(device, NOW)).toEqual([78]);
      expect(canE2eeDeviceJoin(device, 4660, NOW)).toBe(false);
      // Once accepted, the same signature covers it: no new grant.
      const accepted = [79, 78, 4660];
      expect(e2eeDeviceSuites(device, NOW, { accepted })).toEqual([78, 4660]);
      expect(canE2eeDeviceJoin(device, 4660, NOW, { accepted })).toBe(true);
    });

    it('applies the alias table (empty by default) to the signed set', () => {
      expect(E2EE_SUITE_ALIASES).toEqual([]);
      const aliases = [{ from: 78, to: 4660 }];
      const accepted = [79, 78, 4660];
      expect(e2eeDeviceSuites(v2([78]), NOW, { accepted, aliases })).toEqual([
        78, 4660
      ]);
      // An alias target the server does not accept grants nothing.
      expect(e2eeDeviceSuites(v2([78]), NOW, { aliases })).toEqual([78]);
      // Aliases never widen v1 grants.
      expect(
        e2eeDeviceSuites(v1(79), NOW, {
          accepted,
          aliases: [{ from: 79, to: 4660 }],
          transition: OPEN
        })
      ).toEqual([79]);
    });

    it('treats a corrupt stored set as no suites', () => {
      expect(
        e2eeDeviceSuites(
          { grant_version: 2, ciphersuite: 78, ciphersuites: '79.78' },
          NOW
        )
      ).toEqual([]);
      expect(
        e2eeDeviceSuites(
          { grant_version: 2, ciphersuite: 78, ciphersuites: null },
          NOW
        )
      ).toEqual([]);
    });
  });
});
