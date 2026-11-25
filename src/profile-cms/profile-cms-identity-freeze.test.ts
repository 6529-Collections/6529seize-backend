import {
  isProfileCmsIdentityFreezeOn,
  parseProfileCmsFreezeAt,
  profileCmsFrozenError
} from '@/profile-cms/profile-cms-identity-freeze';

const NOON = Date.parse('2026-11-24T12:00:00.000Z');

describe('isProfileCmsIdentityFreezeOn', () => {
  it.each([
    ['the flag', { FEATURE_IDENTITY_FROZEN: 'true' }, true],
    ['nothing set', {}, false],
    ['the flag off', { FEATURE_IDENTITY_FROZEN: 'false' }, false],
    [
      'a start in the past',
      { IDENTITY_FREEZE_AT: '2026-11-24T00:00:00Z' },
      true
    ],
    [
      'a start in the future',
      { IDENTITY_FREEZE_AT: '2026-11-25T00:00:00Z' },
      false
    ],
    ['a start in ms', { IDENTITY_FREEZE_AT: String(NOON) }, true],
    ['a start one ms later', { IDENTITY_FREEZE_AT: String(NOON + 1) }, false],
    ['a value that is not a time', { IDENTITY_FREEZE_AT: 'tomorrow' }, true],
    ['a local time', { IDENTITY_FREEZE_AT: '2026-11-24T00:00:00+01:00' }, true]
  ])('with %s', (_name, env, frozen) => {
    expect(isProfileCmsIdentityFreezeOn(NOON, env)).toBe(frozen);
  });

  it.each([
    [undefined, undefined],
    ['', undefined],
    ['  ', undefined],
    ['2026-11-24T00:00:00Z', Date.UTC(2026, 10, 24)],
    ['2026-11-24T00:00:00+00:00', Date.UTC(2026, 10, 24)],
    ['2026-11-24T00:00:00.000-00:00', Date.UTC(2026, 10, 24)],
    ['2026-11-24T00:00:00.250Z', Date.UTC(2026, 10, 24) + 250],
    [' 1795996800000 ', 1795996800000],
    ['tomorrow', null],
    ['2026-11-24T00:00:00+01:00', null],
    ['2026-11-24', null]
  ])('reads IDENTITY_FREEZE_AT %j as %j', (raw, expected) => {
    expect(parseProfileCmsFreezeAt(raw)).toBe(expected);
  });

  it('answers as the identity routes do: 423 IDENTITY_FROZEN', () => {
    const error = profileCmsFrozenError('frozen');
    expect(error.getStatusCode()).toBe(423);
    expect(error.code).toBe('IDENTITY_FROZEN');
  });
});
