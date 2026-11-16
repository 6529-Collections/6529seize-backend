import { ObjectSkipReason } from './chat-media-object-processor';
import {
  DEFAULT_RETRY_SKIP_REASONS,
  parseSkipReasons,
  skippedKeysFromReport
} from './skipped-keys';

const REPORT = {
  keys: {
    skipped: {
      verification_failed: { keys: ['drops/a/1.jpg', 'drops/a/2.gif'] },
      too_large: { keys: ['drops/a/3.png'], truncated: 7 },
      gain_map_not_kept: { keys: ['drops/a/4.jpg'] }
    }
  }
};

describe('skippedKeysFromReport', () => {
  it('takes the keys skipped for the requested reasons only', () => {
    const result = skippedKeysFromReport(REPORT, DEFAULT_RETRY_SKIP_REASONS);
    expect(Array.from(result.keys)).toEqual([
      'drops/a/1.jpg',
      'drops/a/2.gif',
      'drops/a/3.png'
    ]);
    expect(result.listed).toEqual({
      verification_failed: 2,
      too_large: 1,
      unparseable_container: 0
    });
    expect(result.truncated).toEqual({ too_large: 7 });
  });

  it.each([
    [{}, 'no keys.skipped'],
    [{ keys: { skipped: [] } }, 'no keys.skipped'],
    [
      { keys: { skipped: { too_large: { keys: [1] } } } },
      'keys.skipped.too_large'
    ],
    [{ keys: { skipped: { too_large: 'x' } } }, 'keys.skipped.too_large']
  ])('rejects a malformed report %j', (report, message) => {
    expect(() =>
      skippedKeysFromReport(report, [ObjectSkipReason.TOO_LARGE])
    ).toThrow(message);
  });
});

describe('parseSkipReasons', () => {
  it('reads a comma-separated list once each', () => {
    expect(
      parseSkipReasons('too_large, verification_failed,too_large')
    ).toEqual([
      ObjectSkipReason.TOO_LARGE,
      ObjectSkipReason.VERIFICATION_FAILED
    ]);
  });

  it.each([
    ['', 'at least one'],
    ['too_big', 'Unknown skip reason "too_big"']
  ])('rejects %j', (value, message) => {
    expect(() => parseSkipReasons(value)).toThrow(message);
  });
});
