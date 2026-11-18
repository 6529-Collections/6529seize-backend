import fc from 'fast-check';
import {
  chunk,
  compareStrings,
  identifier,
  placeholders,
  retryOnLockConflict,
  sha256Lines
} from './operator-sql';

describe('operator SQL helpers', () => {
  it('chunks without losing or reordering values', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer()),
        fc.integer({ min: 1, max: 20 }),
        (values, size) => {
          const chunks = chunk(values, size);
          expect(chunks.flat()).toEqual(values);
          expect(chunks.every((part) => part.length <= size)).toBe(true);
        }
      )
    );
  });

  it('orders strings by code unit, independent of locale', () => {
    expect(['b', 'B', 'a'].sort(compareStrings)).toEqual(['B', 'a', 'b']);
  });

  it('hashes line lists deterministically', () => {
    expect(sha256Lines(['a', 'b'])).toBe(sha256Lines(['a', 'b']));
    expect(sha256Lines(['a', 'b'])).not.toBe(sha256Lines(['ab']));
  });

  it('refuses empty IN lists and unsafe identifiers', () => {
    expect(placeholders([1, 2])).toBe('?, ?');
    expect(() => placeholders([])).toThrow();
    expect(identifier('profile_activity_logs')).toBe('`profile_activity_logs`');
    expect(() => identifier('x`; DROP TABLE y')).toThrow();
  });

  it('retries only lock conflicts', async () => {
    let calls = 0;
    const deadlock = Object.assign(new Error('deadlock'), {
      driverError: { code: 'ER_LOCK_DEADLOCK' }
    });
    await expect(
      retryOnLockConflict(async () => {
        calls++;
        if (calls < 2) throw deadlock;
        return 'done';
      })
    ).resolves.toBe('done');
    expect(calls).toBe(2);
    await expect(
      retryOnLockConflict(async () => {
        throw new Error('other');
      })
    ).rejects.toThrow('other');
  });
});
