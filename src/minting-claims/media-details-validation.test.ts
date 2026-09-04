import {
  getImageDetailIssues,
  getAnimationDetailIssues
} from '@/minting-claims/media-details-validation';

const image = {
  bytes: 250_000_000,
  format: 'PNG',
  sha256: 'a'.repeat(64),
  width: 100,
  height: 200
};
const video = { ...image, format: 'MP4', duration: 1, codecs: ['avc1'] };

describe('shared media-detail validation', () => {
  it.each([null, undefined, [], 'not an object', 0])(
    'rejects missing or non-object details %j',
    (details) => {
      expect(getImageDetailIssues(details)).not.toHaveLength(0);
      expect(getAnimationDetailIssues(details)).not.toHaveLength(0);
    }
  );

  it.each(['bytes', 'format', 'sha256', 'width', 'height'])(
    'requires image detail %s',
    (key) => {
      const details: Record<string, unknown> = { ...image };
      delete details[key];
      expect(getImageDetailIssues(details).join(' ')).toContain(
        `missing keys: ${key}`
      );
    }
  );

  it.each([
    'bytes',
    'format',
    'duration',
    'sha256',
    'width',
    'height',
    'codecs'
  ])('requires video detail %s', (key) => {
    const details: Record<string, unknown> = { ...video };
    delete details[key];
    expect(getAnimationDetailIssues(details).join(' ')).toContain(
      `missing keys: ${key}`
    );
  });

  it.each([
    { bytes: 0 },
    { bytes: 250_000_001 },
    { bytes: 1.5 },
    { bytes: '100' },
    { sha256: '' },
    { sha256: 'z'.repeat(64) },
    { width: 0 },
    { height: -1 },
    { duration: Number.NaN },
    { duration: Number.POSITIVE_INFINITY },
    { codecs: [] },
    { codecs: [' '] },
    { codecs: [null] },
    { format: 'OTHER' }
  ])('rejects invalid binary/video values %j', (overrides) => {
    expect(
      getAnimationDetailIssues({ ...video, ...overrides })
    ).not.toHaveLength(0);
  });

  it('accepts the exact limit and keeps image, video, GLB, and HTML rules distinct', () => {
    expect(getImageDetailIssues(image)).toEqual([]);
    expect(getAnimationDetailIssues(video)).toEqual([]);
    expect(getAnimationDetailIssues({ ...video, format: 'MOV' })).toEqual([]);
    expect(
      getAnimationDetailIssues({
        bytes: image.bytes,
        sha256: image.sha256,
        format: 'GLB'
      })
    ).toEqual([]);
    expect(getAnimationDetailIssues({ format: 'HTML' })).toEqual([]);
  });
});
