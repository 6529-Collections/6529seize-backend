import { apiCompliantErrorBody } from '@/exceptions';
import {
  assertDecisionNotFrozen,
  assertWavesNotFrozen,
  isDecisionFrozen,
  isMainStageDecision,
  isWavesFrozen,
  parseWavesFreezeAt,
  WAVES_FROZEN_CODE,
  WAVES_FROZEN_MESSAGE,
  WavesFrozenException
} from '@/waves-freeze/waves-freeze';

const FLAG = 'FEATURE_WAVES_FROZEN';
const KEEP = 'FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE';
const AT = 'WAVES_FREEZE_AT';
const MAIN_STAGE_WAVE = 'MAIN_STAGE_WAVE_ID';
const T = Date.UTC(2026, 10, 25, 0, 0, 0);

const ENV_NAMES = [FLAG, KEEP, AT, MAIN_STAGE_WAVE];

describe('waves freeze', () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of ENV_NAMES) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of ENV_NAMES) delete process.env[name];
  });
  afterAll(() => {
    for (const name of ENV_NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  it.each([
    [undefined, false],
    ['true', true],
    ['false', false],
    ['TRUE', false],
    ['1', false],
    ['', false]
  ])('reads FEATURE_WAVES_FROZEN=%s as %s', (value, frozen) => {
    if (value !== undefined) process.env[FLAG] = value;
    expect(isWavesFrozen()).toBe(frozen);
    if (frozen) {
      expect(() => assertWavesNotFrozen()).toThrow(WavesFrozenException);
    } else {
      expect(() => assertWavesNotFrozen()).not.toThrow();
    }
  });

  it('answers 423 with the freeze code and a plain message', () => {
    process.env[FLAG] = 'true';
    let thrown: unknown;
    try {
      assertWavesNotFrozen();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WavesFrozenException);
    const error = thrown as WavesFrozenException;
    expect(error.getStatusCode()).toBe(423);
    expect(apiCompliantErrorBody(error)).toEqual({
      error: WAVES_FROZEN_MESSAGE,
      code: WAVES_FROZEN_CODE
    });
  });

  it.each([
    ['2026-11-25T00:00:00Z', T],
    ['2026-11-25T00:00Z', T],
    ['2026-11-25T00:00:00.000Z', T],
    ['2026-11-25T00:00:00+00:00', T],
    [String(T), T],
    ['  2026-11-25T00:00:00Z  ', T]
  ])('reads WAVES_FREEZE_AT=%s as a UTC time', (raw, expected) => {
    expect(parseWavesFreezeAt(raw)).toBe(expected);
  });

  it.each([
    '2026-11-25 00:00',
    '2026-11-25T00:00:00',
    '2026-11-25T01:00:00+01:00',
    'tomorrow',
    '2026-13-40T00:00:00Z',
    '0',
    'false',
    String(Math.floor(T / 1000)),
    // Days that don't exist, which Date.parse moves into the next month.
    '2026-11-31T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-11-31T24:00:00Z',
    // Past the end of the day.
    '2026-11-24T24:01:00Z',
    '2026-11-24T24:00:01Z',
    '2026-11-24T24:00:00.001Z',
    // Before 2020.
    '2019-12-31T23:59:59.999Z',
    String(Date.UTC(2020, 0, 1) - 1),
    // Times the freeze would never reach: microseconds, year 9999, 2100.
    String(T * 1000),
    '9999-12-31T00:00:00Z',
    '2100-01-01T00:00:00Z',
    String(Date.UTC(2100, 0, 1))
  ])('reads WAVES_FREEZE_AT=%s as no UTC time', (raw) => {
    expect(parseWavesFreezeAt(raw)).toBeNull();
  });

  it.each([undefined, '', '   '])(
    'reads an unset WAVES_FREEZE_AT (%s) as no freeze time',
    (raw) => {
      expect(parseWavesFreezeAt(raw)).toBeUndefined();
    }
  );

  it('freezes from WAVES_FREEZE_AT on, without the flag', () => {
    process.env[AT] = '2026-11-25T00:00:00Z';
    expect(isWavesFrozen(T - 1)).toBe(false);
    expect(isWavesFrozen(T)).toBe(true);
    expect(isWavesFrozen(T + 60_000)).toBe(true);
  });

  it.each([
    '25 Nov 2026',
    '2026-11-31T00:00:00Z',
    String(T * 1000),
    '9999-12-31T00:00:00Z'
  ])('freezes at once on a malformed WAVES_FREEZE_AT (%s)', (raw) => {
    process.env[AT] = raw;
    expect(isWavesFrozen(0)).toBe(true);
  });

  it.each([
    ['2026-11-24T24:00:00Z', T],
    ['2026-11-24T24:00Z', T],
    ['2026-11-24T24:00:00.000Z', T],
    ['2026-11-24T24:00:00+00:00', T],
    ['2026-12-31T24:00:00Z', Date.UTC(2027, 0, 1)]
  ])(
    'reads WAVES_FREEZE_AT=%s (24:00) as the next day 00:00',
    (raw, expected) => {
      expect(parseWavesFreezeAt(raw)).toBe(expected);
    }
  );

  it('reads 2020-01-01 00:00 UTC as the earliest freeze time', () => {
    expect(parseWavesFreezeAt('2020-01-01T00:00:00Z')).toBe(
      Date.UTC(2020, 0, 1)
    );
    expect(parseWavesFreezeAt(String(Date.UTC(2020, 0, 1)))).toBe(
      Date.UTC(2020, 0, 1)
    );
  });

  it('reads the last day of each month and a leap day as UTC times', () => {
    expect(parseWavesFreezeAt('2026-11-30T00:00:00Z')).toBe(
      Date.UTC(2026, 10, 30)
    );
    expect(parseWavesFreezeAt('2028-02-29T00:00:00Z')).toBe(
      Date.UTC(2028, 1, 29)
    );
    expect(parseWavesFreezeAt('2099-12-31T23:59:59Z')).toBe(
      Date.UTC(2099, 11, 31, 23, 59, 59)
    );
  });

  it('the flag freezes before WAVES_FREEZE_AT too', () => {
    process.env[FLAG] = 'true';
    process.env[AT] = '2026-11-25T00:00:00Z';
    expect(isWavesFrozen(T - 1)).toBe(true);
  });

  it('does not touch the identity freeze settings', () => {
    process.env.FEATURE_IDENTITY_FROZEN = 'true';
    try {
      expect(isWavesFrozen()).toBe(false);
    } finally {
      delete process.env.FEATURE_IDENTITY_FROZEN;
    }
  });

  describe('the Main Stage', () => {
    it('is the decision with the MAIN_STAGE capability', () => {
      expect(isMainStageDecision({ capabilities: ['MAIN_STAGE'] })).toBe(true);
      expect(isMainStageDecision({ capabilities: ['CURATION'] })).toBe(false);
      expect(isMainStageDecision({})).toBe(false);
    });

    it('goes by the capability whenever the decision is known', () => {
      process.env[MAIN_STAGE_WAVE] = 'main-stage-wave';
      expect(
        isMainStageDecision({ capabilities: [], wave_id: 'main-stage-wave' })
      ).toBe(false);
      expect(
        isMainStageDecision({ capabilities: ['MAIN_STAGE'], wave_id: 'other' })
      ).toBe(true);
    });

    it('is the decision of MAIN_STAGE_WAVE_ID where only the wave is known', () => {
      process.env[MAIN_STAGE_WAVE] = 'main-stage-wave';
      expect(isMainStageDecision({ wave_id: 'main-stage-wave' })).toBe(true);
      expect(
        isMainStageDecision({
          wave_id: 'hub',
          legacy_wave_id: 'main-stage-wave'
        })
      ).toBe(true);
      expect(isMainStageDecision({ wave_id: 'other-wave' })).toBe(false);
      expect(isMainStageDecision({ wave_id: null })).toBe(false);
    });

    it('never matches without MAIN_STAGE_WAVE_ID', () => {
      expect(isMainStageDecision({ wave_id: '' })).toBe(false);
      expect(isMainStageDecision({ wave_id: 'main-stage-wave' })).toBe(false);
    });
  });

  describe('decisions', () => {
    const mainStage = { capabilities: ['MAIN_STAGE'], wave_id: 'w-main' };
    const other = { capabilities: [], wave_id: 'w-other' };

    it('are open when waves are not frozen', () => {
      process.env[KEEP] = 'true';
      expect(isDecisionFrozen(other)).toBe(false);
      expect(isDecisionFrozen(mainStage)).toBe(false);
      expect(() => assertDecisionNotFrozen(other)).not.toThrow();
    });

    it('all freeze with the waves by default, the Main Stage too', () => {
      process.env[FLAG] = 'true';
      expect(isDecisionFrozen(other)).toBe(true);
      expect(isDecisionFrozen(mainStage)).toBe(true);
      expect(() => assertDecisionNotFrozen(mainStage)).toThrow(
        WavesFrozenException
      );
    });

    it('the Main Stage keeps running when the freeze keeps it', () => {
      process.env[FLAG] = 'true';
      process.env[KEEP] = 'true';
      expect(isDecisionFrozen(mainStage)).toBe(false);
      expect(isDecisionFrozen(other)).toBe(true);
      expect(() => assertDecisionNotFrozen(mainStage)).not.toThrow();
      expect(() => assertDecisionNotFrozen(other)).toThrow(
        WavesFrozenException
      );
    });

    it('follows WAVES_FREEZE_AT', () => {
      process.env[AT] = String(T);
      expect(isDecisionFrozen(other, T - 1)).toBe(false);
      expect(isDecisionFrozen(other, T)).toBe(true);
    });
  });
});
