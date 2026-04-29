import fc from 'fast-check';
import {
  getDropMediaTextForPush,
  sanitizePushNotificationText,
  truncatePushNotificationFileName
} from './push-notification-text';

describe('sanitizePushNotificationText', () => {
  it('replaces markdown images with a short placeholder', () => {
    expect(
      sanitizePushNotificationText(
        'hello ![Seize](https://d3lqz0a4bldqgf.cloudfront.net/drops/author_0f8314ef-87b4-11ee-9d82-029a0e4b6159/971ffd5b-dec6-421e-b707-1f73c402a765/punk6529.png) world'
      )
    ).toBe('hello sent punk6529.png world');
  });

  it('replaces bare media urls without replacing ordinary links', () => {
    expect(
      sanitizePushNotificationText(
        'image https://example.com/path/card.webp?size=large video https://example.com/drop.mp4 and https://github.com/6529-Collections/6529seize-backend/pull/1535'
      )
    ).toBe(
      'image sent card.webp video sent drop.mp4 and https://github.com/6529-Collections/6529seize-backend/pull/1535'
    );
  });

  it('uses placeholders for all supported non-image upload media types', () => {
    expect(
      sanitizePushNotificationText(
        'files https://example.com/sound.wav https://example.com/model.glb https://example.com/report.pdf https://example.com/data.csv'
      )
    ).toBe('files sent sound.wav sent model.glb sent report.pdf sent data.csv');
  });

  it('replaces markdown links to media without changing regular markdown links', () => {
    expect(
      sanitizePushNotificationText(
        'see [report](https://example.com/report.pdf) and [pr](https://github.com/6529-Collections/6529seize-backend/pull/1535)'
      )
    ).toBe(
      'see sent report.pdf and [pr](https://github.com/6529-Collections/6529seize-backend/pull/1535)'
    );
  });

  it('keeps text readable when image markdown touches surrounding text', () => {
    expect(
      sanitizePushNotificationText(
        'an image with text in same message![Seize](https://example.com/intern-fallback-pfp.png)'
      )
    ).toBe('an image with text in same message sent intern-fallback-pfp.png');
  });

  it('does not leak markdown image urls', () => {
    fc.assert(
      fc.property(
        fc.webUrl().filter((url) => !/[()]/.test(url)),
        (url) => {
          const text = `before ![alt](${url}) after`;

          expect(sanitizePushNotificationText(text)).not.toContain(url);
        }
      )
    );
  });
});

describe('getDropMediaTextForPush', () => {
  it('labels csv from mime and filename from url path', () => {
    expect(
      getDropMediaTextForPush(
        'https://cdn.example.com/waves/x/report.csv',
        'text/csv'
      )
    ).toBe('report.csv');
  });

  it('uses url extension when mime does not map to a known label', () => {
    expect(
      getDropMediaTextForPush(
        'https://cdn.example.com/waves/x/report.csv',
        'application/octet-stream'
      )
    ).toBe('report.csv');
  });

  it('uses mime when url path has no media extension', () => {
    expect(
      getDropMediaTextForPush(
        'https://cdn.example.com/objects/a1b2c3d4-e5f6',
        'text/csv'
      )
    ).toBe('a1b2c3d4-e5f6');
  });

  it('middle-truncates long media filenames while preserving the extension', () => {
    expect(
      getDropMediaTextForPush(
        'https://cdn.example.com/waves/x/2rQCvx8juLsauGyN_gu7GWyRFtYGbSNc-PNZyVg0Ay8U.csv',
        'text/csv'
      )
    ).toBe('2rQC.....Ay8U.csv');
  });
});

describe('truncatePushNotificationFileName', () => {
  it('middle-truncates long attachment filenames while preserving the extension', () => {
    expect(
      truncatePushNotificationFileName(
        'quarterly-export-with-a-very-long-name.csv'
      )
    ).toBe('quar.....name.csv');
  });

  it('middle-truncates long filenames without extensions', () => {
    expect(
      truncatePushNotificationFileName('attachment-name-with-no-extension')
    ).toBe('atta.....sion');
  });
});
