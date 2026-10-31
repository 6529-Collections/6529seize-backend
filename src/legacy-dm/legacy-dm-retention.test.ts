import {
  DEFAULT_LEGACY_DM_DELETION_CUTOFF,
  isLegacyDmClosed,
  legacyDmClosedMessage,
  legacyDmDeletionCutoffIso,
  legacyDmDeletionCutoffMillis
} from './legacy-dm-retention';

const DECIDED = Date.parse('2026-12-01T00:00:00Z');

describe('legacy DM deletion cutoff', () => {
  it('defaults to the decided date, 2026-12-01T00:00Z', () => {
    expect(DEFAULT_LEGACY_DM_DELETION_CUTOFF).toBe('2026-12-01T00:00:00.000Z');
    expect(legacyDmDeletionCutoffMillis({})).toBe(DECIDED);
    expect(legacyDmDeletionCutoffIso({})).toBe('2026-12-01T00:00:00.000Z');
  });

  it.each([
    ['2026-11-15T12:00:00Z', Date.parse('2026-11-15T12:00:00Z')],
    ['2026-11-15T12:00Z', Date.parse('2026-11-15T12:00:00Z')],
    [' 2026-11-15T12:00:00.250Z ', Date.parse('2026-11-15T12:00:00.250Z')]
  ])('accepts the UTC override %s', (value, expected) => {
    expect(
      legacyDmDeletionCutoffMillis({ LEGACY_DM_DELETION_CUTOFF: value })
    ).toBe(expected);
  });

  it.each([
    '2026-11-15',
    '2026-11-15T12:00:00+01:00',
    'tomorrow',
    '',
    '2026-13-45T99:99:99Z'
  ])('falls back to the decided date for %j', (value) => {
    expect(
      legacyDmDeletionCutoffMillis({ LEGACY_DM_DELETION_CUTOFF: value })
    ).toBe(DECIDED);
  });

  it('closes unencrypted DMs from the cutoff on', () => {
    expect(isLegacyDmClosed(DECIDED - 1, {})).toBe(false);
    expect(isLegacyDmClosed(DECIDED, {})).toBe(true);
    expect(isLegacyDmClosed(DECIDED + 1, {})).toBe(true);
  });

  it('names the cutoff in the error message', () => {
    expect(legacyDmClosedMessage({})).toContain('2026-12-01T00:00:00.000Z');
  });
});
