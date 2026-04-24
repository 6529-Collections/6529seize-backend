import fc from 'fast-check';
import { sanitizePushNotificationText } from './push-notification-text';

describe('sanitizePushNotificationText', () => {
  it('replaces markdown images with a short placeholder', () => {
    expect(
      sanitizePushNotificationText(
        'hello ![Seize](https://d3lqz0a4bldqgf.cloudfront.net/drops/author_0f8314ef-87b4-11ee-9d82-029a0e4b6159/971ffd5b-dec6-421e-b707-1f73c402a765/punk6529.png) world'
      )
    ).toBe('hello [Image (punk6529.png)] world');
  });

  it('replaces bare media urls without replacing ordinary links', () => {
    expect(
      sanitizePushNotificationText(
        'image https://example.com/path/card.webp?size=large video https://example.com/drop.mp4 and https://github.com/6529-Collections/6529seize-backend/pull/1535'
      )
    ).toBe(
      'image [Image (card.webp)] video [Video (drop.mp4)] and https://github.com/6529-Collections/6529seize-backend/pull/1535'
    );
  });

  it('uses placeholders for all supported non-image upload media types', () => {
    expect(
      sanitizePushNotificationText(
        'files https://example.com/sound.wav https://example.com/model.glb https://example.com/report.pdf https://example.com/data.csv'
      )
    ).toBe(
      'files [Audio (sound.wav)] [3D Model (model.glb)] [PDF (report.pdf)] [CSV (data.csv)]'
    );
  });

  it('replaces markdown links to media without changing regular markdown links', () => {
    expect(
      sanitizePushNotificationText(
        'see [report](https://example.com/report.pdf) and [pr](https://github.com/6529-Collections/6529seize-backend/pull/1535)'
      )
    ).toBe(
      'see [PDF (report.pdf)] and [pr](https://github.com/6529-Collections/6529seize-backend/pull/1535)'
    );
  });

  it('keeps text readable when image markdown touches surrounding text', () => {
    expect(
      sanitizePushNotificationText(
        'an image with text in same message![Seize](https://example.com/intern-fallback-pfp.png)'
      )
    ).toBe(
      'an image with text in same message [Image (intern-fallback-pfp.png)]'
    );
  });

  it('does not leak markdown image urls', () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        const text = `before ![alt](${url}) after`;

        expect(sanitizePushNotificationText(text)).not.toContain(url);
      })
    );
  });
});
