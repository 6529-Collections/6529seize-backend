import {
  parseWavesTime,
  WAVES_SWITCH_ON_AT_ENV,
  wavesSwitchedOn
} from '@/waves-freeze/waves-switch-on';

const FLAG = 'FEATURE_WAVES_ON_CHAIN';
const T = Date.UTC(2026, 10, 28);

describe('the waves switch-on', () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of [FLAG, WAVES_SWITCH_ON_AT_ENV])
      original[name] = process.env[name];
  });
  beforeEach(() => {
    delete process.env[FLAG];
    delete process.env[WAVES_SWITCH_ON_AT_ENV];
  });
  afterAll(() => {
    for (const name of [FLAG, WAVES_SWITCH_ON_AT_ENV]) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  it.each([
    ['2026-11-28T00:00:00Z', T],
    ['2026-11-28T00:00Z', T],
    ['2026-11-28T00:00:00.000Z', T],
    ['2026-11-28T00:00:00+00:00', T],
    ['2026-11-27T24:00:00Z', T],
    [String(T), T],
    ['  2026-11-28T00:00:00Z  ', T],
    ['2020-01-01T00:00:00Z', Date.UTC(2020, 0, 1)],
    ['2028-02-29T00:00:00Z', Date.UTC(2028, 1, 29)],
    ['2099-12-31T23:59:59Z', Date.UTC(2099, 11, 31, 23, 59, 59)]
  ])('reads %s as a UTC time', (raw, expected) => {
    expect(parseWavesTime(raw)).toBe(expected);
  });

  it.each([
    '2026-11-28 00:00',
    '2026-11-28T00:00:00',
    '2026-11-28T01:00:00+01:00',
    'tomorrow',
    '2026-13-40T00:00:00Z',
    '0',
    'false',
    String(Math.floor(T / 1000)),
    '2026-11-31T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-11-27T24:01:00Z',
    '2026-11-27T24:00:00.001Z',
    '2019-12-31T23:59:59.999Z',
    String(T * 1000),
    '9999-12-31T00:00:00Z',
    '2100-01-01T00:00:00Z'
  ])('reads %s as no UTC time', (raw) => {
    expect(parseWavesTime(raw)).toBeNull();
  });

  it.each([undefined, '', '   '])('reads %p as unset', (raw) => {
    expect(parseWavesTime(raw)).toBeUndefined();
  });

  it('switches on at WAVES_SWITCH_ON_AT and stays on', () => {
    process.env[WAVES_SWITCH_ON_AT_ENV] = '2026-11-28T00:00:00Z';
    expect(wavesSwitchedOn(T - 1)).toBe(false);
    expect(wavesSwitchedOn(T)).toBe(true);
    expect(wavesSwitchedOn(T + 86_400_000)).toBe(true);
  });

  it.each([
    'false',
    '0',
    String(Math.floor(T / 1000)),
    String(T * 1000),
    '2026-11-31T00:00:00Z',
    '2026-11-28T00:00:00',
    '28 Nov 2026'
  ])('never switches on with a malformed WAVES_SWITCH_ON_AT (%s)', (raw) => {
    process.env[WAVES_SWITCH_ON_AT_ENV] = raw;
    expect(wavesSwitchedOn(T)).toBe(false);
    expect(wavesSwitchedOn(Date.UTC(2099, 0, 1))).toBe(false);
  });

  it('never switches on when WAVES_SWITCH_ON_AT is unset', () => {
    expect(wavesSwitchedOn(Date.UTC(2099, 0, 1))).toBe(false);
  });

  it('switches on with FEATURE_WAVES_ON_CHAIN=true alone, and only with true', () => {
    process.env[FLAG] = 'TRUE';
    expect(wavesSwitchedOn(T)).toBe(false);
    process.env[FLAG] = 'true';
    expect(wavesSwitchedOn(0)).toBe(true);
  });

  it('reads the settings on every call, with no restart', () => {
    expect(wavesSwitchedOn(T)).toBe(false);
    process.env[WAVES_SWITCH_ON_AT_ENV] = String(T);
    expect(wavesSwitchedOn(T)).toBe(true);
    delete process.env[WAVES_SWITCH_ON_AT_ENV];
    expect(wavesSwitchedOn(T)).toBe(false);
  });
});
