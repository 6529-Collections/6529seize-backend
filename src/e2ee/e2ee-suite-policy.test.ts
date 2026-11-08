import * as fc from 'fast-check';
import {
  canE2eeDeviceJoin,
  decodeE2eeSuiteSet,
  E2EE_SUITE_ALIASES,
  e2eeDeviceSuites,
  encodeE2eeSuiteSet,
  isCanonicalE2eeSuiteSet,
  currentE2eeSuiteTransition,
  describeE2eeSuiteTransition,
  e2eeAcceptedSuites,
  E2eeSuiteTransitionConfigError,
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
          E2EE_SUITE_TRANSITION_START: ' ',
          E2EE_SUITE_TRANSITION_DAYS: ''
        })
      ).toEqual({ startMs: null, days: 14 });
      expect(
        readE2eeSuiteTransition({
          E2EE_SUITE_TRANSITION_START: '2026-11-10T02:00:00+02:00'
        }).startMs
      ).toBe(NOW);

      const started = { startMs: NOW, days: 14 };
      expect(isE2eeV1GrantAccepted(NOW, OPEN)).toBe(true);
      expect(isE2eeV1GrantAccepted(NOW + 14 * DAY - 1, started)).toBe(true);
      expect(isE2eeV1GrantAccepted(NOW + 14 * DAY, started)).toBe(false);
    });
  });

  describe('transition settings are checked, not guessed', () => {
    const start = (value: string) =>
      readE2eeSuiteTransition({ E2EE_SUITE_TRANSITION_START: value });
    const days = (value: string) =>
      readE2eeSuiteTransition({ E2EE_SUITE_TRANSITION_DAYS: value });

    it('accepts a start from the D172 decision (2026-11-08) on', () => {
      expect(start('2026-11-08T00:00:00Z').startMs).toBe(Date.UTC(2026, 10, 8));
      expect(start(String(Date.UTC(2026, 10, 8))).startMs).toBe(
        Date.UTC(2026, 10, 8)
      );
    });

    it('refuses unix seconds, which would close the window at once', () => {
      expect(() => start(String(NOW / 1000))).toThrow(
        E2eeSuiteTransitionConfigError
      );
      expect(start(String(NOW)).startMs).toBe(NOW);
    });

    it.each([
      ['garbage', 'not a date'],
      ['a date without a time', '2026-11-10'],
      ['a time without a zone', '2026-11-10T00:00:00'],
      ['an impossible date', '2026-13-45T00:00:00Z'],
      ['a negative number', '-1'],
      ['a start before 2026', String(Date.UTC(2025, 11, 31))],
      ['a well-formed typo before D172', '2026-01-11T00:00:00Z'],
      ['a start just before D172', String(Date.UTC(2026, 10, 8) - 1)],
      ['a start after 2099', String(Date.UTC(2100, 0, 1))]
    ])('refuses %s as the start', (_label, value) => {
      expect(() => start(value)).toThrow(
        /E2EE_SUITE_TRANSITION_START=.* is not an ISO 8601 date-time/
      );
    });

    it.each(['0', '-3', '366', '1.5', 'two'])(
      'refuses %s as the number of days',
      (value) => {
        expect(() => days(value)).toThrow(
          /E2EE_SUITE_TRANSITION_DAYS=.* is not a whole number of days/
        );
      }
    );

    it.each([
      ['a day past the end of the month', '2026-11-31T00:00:00Z'],
      ['February 29 in a common year', '2026-02-29T00:00:00Z'],
      ['hour 24', '2026-11-10T24:00:00Z'],
      ['minute 60', '2026-11-10T10:60:00Z']
    ])('refuses %s instead of rolling it over', (_label, value) => {
      expect(() => start(value)).toThrow(E2eeSuiteTransitionConfigError);
    });

    it('fails safe on a malformed value: reported once, treated as not started', () => {
      const write = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      try {
        const env = { E2EE_SUITE_TRANSITION_START: '1763000000' };
        expect(currentE2eeSuiteTransition(env)).toEqual({
          startMs: null,
          days: 14
        });
        expect(currentE2eeSuiteTransition(env)).toEqual({
          startMs: null,
          days: 14
        });
        const metrics = write.mock.calls
          .map(([line]) => String(line))
          .filter((line) => line.includes('SuiteWindowConfigInvalid'));
        expect(metrics).toHaveLength(1);
        expect(JSON.parse(metrics[0])).toMatchObject({
          SuiteWindowConfigInvalid: 1,
          _aws: {
            CloudWatchMetrics: [
              expect.objectContaining({ Namespace: '6529/E2EE' })
            ]
          }
        });
        expect(describeE2eeSuiteTransition(env)).toBe(
          '[E2EE SUITE WINDOW NOT STARTED] [BOTH SUITES ACCEPTED]'
        );
        expect(
          currentE2eeSuiteTransition({ E2EE_SUITE_TRANSITION_DAYS: 'two' })
        ).toEqual({ startMs: null, days: 14 });
      } finally {
        write.mockRestore();
      }
    });

    it('describes the effective window for the start-up log', () => {
      expect(describeE2eeSuiteTransition({})).toBe(
        '[E2EE SUITE WINDOW NOT STARTED] [BOTH SUITES ACCEPTED]'
      );
      expect(
        describeE2eeSuiteTransition({
          E2EE_SUITE_TRANSITION_START: '2026-11-10T00:00:00Z',
          E2EE_SUITE_TRANSITION_DAYS: '7'
        })
      ).toBe(
        '[E2EE SUITE WINDOW START 2026-11-10T00:00:00.000Z] ' +
          '[END 2026-11-17T00:00:00.000Z] [DAYS 7]'
      );
    });
  });

  describe('accepted suites', () => {
    it('accepts both suites while the window is open, then 0x004E only', () => {
      expect(e2eeAcceptedSuites(NOW, OPEN)).toEqual([0x004f, 0x004e]);
      expect(e2eeAcceptedSuites(NOW, CLOSED)).toEqual([0x004e]);
      expect(e2eeDeviceSuites(v2([78, 79]), NOW, { transition: OPEN })).toEqual(
        [78, 79]
      );
      expect(
        e2eeDeviceSuites(v2([78, 79]), NOW, { transition: CLOSED })
      ).toEqual([78]);
      expect(e2eeDeviceSuites(v2([79]), NOW, { transition: CLOSED })).toEqual(
        []
      );
      expect(canE2eeDeviceJoin(v2([79]), 79, NOW, { transition: OPEN })).toBe(
        true
      );
      expect(canE2eeDeviceJoin(v2([79]), 79, NOW, { transition: CLOSED })).toBe(
        false
      );
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

    it('gives a v2 grant its accepted suites (0x004E survives the window)', () => {
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
