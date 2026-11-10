import fc from 'fast-check';
import { BadRequestException } from '@/exceptions';
import {
  isWaveAllowedByAllowlist,
  normalizeWaveAllowlist,
  parseStoredWaveAllowlist,
  PROXY_WAVE_ALLOWLIST_MAX_ENTRIES,
  serializeWaveAllowlist
} from './proxy-wave-allowlist';

const waveId = fc.string({ minLength: 1, maxLength: 100 });
const uniqueWaveIds = fc.uniqueArray(waveId, {
  minLength: 1,
  maxLength: PROXY_WAVE_ALLOWLIST_MAX_ENTRIES
});

describe('normalizeWaveAllowlist', () => {
  it('treats omitted and null as the legacy unrestricted grant', () => {
    expect(normalizeWaveAllowlist(undefined)).toBeNull();
    expect(normalizeWaveAllowlist(null)).toBeNull();
  });

  it('keeps any valid list exactly as sent', () => {
    fc.assert(
      fc.property(uniqueWaveIds, (ids) => {
        expect(normalizeWaveAllowlist(ids)).toEqual(ids);
      })
    );
  });

  it('rejects an empty list instead of treating it as unrestricted', () => {
    expect(() => normalizeWaveAllowlist([])).toThrow(BadRequestException);
  });

  it.each([
    ['a string', 'wave-1'],
    ['a number', 1],
    ['an object', { wave_id: 'wave-1' }],
    ['a list with a non-string', ['wave-1', 2]],
    ['a list with an empty id', ['wave-1', '']],
    ['a list with a null id', ['wave-1', null]],
    ['a list with duplicates', ['wave-1', 'wave-1']],
    ['an id longer than 100 characters', ['x'.repeat(101)]]
  ])('rejects %s with 400', (_label, input) => {
    expect(() => normalizeWaveAllowlist(input)).toThrow(BadRequestException);
  });

  it('rejects lists above the size bound', () => {
    const tooMany = Array.from(
      { length: PROXY_WAVE_ALLOWLIST_MAX_ENTRIES + 1 },
      (_, i) => `wave-${i}`
    );
    expect(() => normalizeWaveAllowlist(tooMany)).toThrow(BadRequestException);
    expect(normalizeWaveAllowlist(tooMany.slice(1))).toHaveLength(
      PROXY_WAVE_ALLOWLIST_MAX_ENTRIES
    );
  });

  it('rejects duplicates anywhere in the list', () => {
    fc.assert(
      fc.property(uniqueWaveIds, fc.nat(), (ids, seed) => {
        const duplicated = [...ids, ids[seed % ids.length]];
        expect(() => normalizeWaveAllowlist(duplicated)).toThrow(
          BadRequestException
        );
      })
    );
  });
});

describe('stored allowlist round trip', () => {
  it('serialises null as NULL and lists as JSON', () => {
    expect(serializeWaveAllowlist(null)).toBeNull();
    expect(serializeWaveAllowlist(undefined)).toBeNull();
    expect(serializeWaveAllowlist(['a', 'b'])).toBe('["a","b"]');
  });

  it('parses what it serialised', () => {
    fc.assert(
      fc.property(uniqueWaveIds, (ids) => {
        expect(parseStoredWaveAllowlist(serializeWaveAllowlist(ids))).toEqual(
          ids
        );
      })
    );
    expect(parseStoredWaveAllowlist(null)).toBeNull();
    expect(parseStoredWaveAllowlist(undefined)).toBeNull();
    expect(parseStoredWaveAllowlist('null')).toBeNull();
  });

  it('accepts a driver that already decoded the JSON', () => {
    expect(parseStoredWaveAllowlist(['a'])).toEqual(['a']);
  });

  it('fails closed on corrupt stored values', () => {
    expect(parseStoredWaveAllowlist('not json')).toEqual([]);
    expect(parseStoredWaveAllowlist('{"a":1}')).toEqual([]);
    expect(parseStoredWaveAllowlist('["a", 1, null]')).toEqual(['a']);
  });
});

describe('isWaveAllowedByAllowlist', () => {
  it('allows every wave for the legacy unrestricted grant', () => {
    fc.assert(
      fc.property(waveId, (id) => {
        expect(isWaveAllowedByAllowlist(null, id)).toBe(true);
        expect(isWaveAllowedByAllowlist(undefined, id)).toBe(true);
      })
    );
  });

  it('allows exactly the listed waves', () => {
    fc.assert(
      fc.property(uniqueWaveIds, waveId, (ids, probe) => {
        expect(isWaveAllowedByAllowlist(ids, probe)).toBe(ids.includes(probe));
      })
    );
  });

  it('never allows anything for an empty list', () => {
    fc.assert(
      fc.property(waveId, (id) => {
        expect(isWaveAllowedByAllowlist([], id)).toBe(false);
      })
    );
  });
});
