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
const T = Date.UTC(2026, 10, 24, 6, 0, 0);

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
    ['2026-11-24T06:00:00Z', T],
    ['2026-11-24T06:00Z', T],
    ['2026-11-24T06:00:00.000Z', T],
    ['2026-11-24T06:00:00+00:00', T],
    [String(T), T],
    ['  2026-11-24T06:00:00Z  ', T]
  ])('reads WAVES_FREEZE_AT=%s as a UTC time', (raw, expected) => {
    expect(parseWavesFreezeAt(raw)).toBe(expected);
  });

  it.each([
    '2026-11-24 06:00',
    '2026-11-24T06:00:00',
    '2026-11-24T07:00:00+01:00',
    'tomorrow',
    '2026-13-40T00:00:00Z'
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
    process.env[AT] = '2026-11-24T06:00:00Z';
    expect(isWavesFrozen(T - 1)).toBe(false);
    expect(isWavesFrozen(T)).toBe(true);
    expect(isWavesFrozen(T + 60_000)).toBe(true);
  });

  it('freezes on a malformed WAVES_FREEZE_AT', () => {
    process.env[AT] = '24 Nov 2026';
    expect(isWavesFrozen(0)).toBe(true);
  });

  it('the flag freezes before WAVES_FREEZE_AT too', () => {
    process.env[FLAG] = 'true';
    process.env[AT] = '2026-11-24T06:00:00Z';
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

    it('is any decision of MAIN_STAGE_WAVE_ID', () => {
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
