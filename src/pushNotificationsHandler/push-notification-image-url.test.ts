import fc from 'fast-check';
import { isAllowedPushNotificationImageUrl } from '@/pushNotificationsHandler/push-notification-image-url';

const CDN = 'https://d3lqz0a4bldqgf.cloudfront.net';
const GATEWAY = 'https://media.6529.io';

describe('isAllowedPushNotificationImageUrl', () => {
  it.each([
    `${CDN}/pfp/abc.png`,
    `${CDN}/images/original/1.webp?v=2`,
    `  ${CDN}/pfp/abc.png  `,
    `${GATEWAY}/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG`,
    `${GATEWAY}/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/image.png`
  ])('allows %p', (url) => {
    expect(isAllowedPushNotificationImageUrl(url)).toBe(true);
  });

  it.each([
    [undefined],
    [null],
    [''],
    ['   '],
    ['not a url'],
    ['https://example.com/image.jpg'],
    ['http://d3lqz0a4bldqgf.cloudfront.net/pfp/abc.png'],
    [`${CDN}/`],
    [`${CDN}`],
    [`${CDN}:8443/pfp/abc.png`],
    ['https://d3lqz0a4bldqgf.cloudfront.net.example.com/pfp/abc.png'],
    ['https://d3lqz0a4bldqgf.cloudfront.netx/pfp/abc.png'],
    ['https://xd3lqz0a4bldqgf.cloudfront.net/pfp/abc.png'],
    ['https://other.cloudfront.net/pfp/abc.png'],
    ['https://d3lqz0a4bldqgf.cloudfront.net@example.com/pfp/abc.png'],
    ['https://user@d3lqz0a4bldqgf.cloudfront.net/pfp/abc.png'],
    ['https://user:pass@d3lqz0a4bldqgf.cloudfront.net/pfp/abc.png'],
    ['https://example.com/@d3lqz0a4bldqgf.cloudfront.net/pfp/abc.png'],
    [`${CDN}/pfp/a b.png`],
    ['ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'],
    [`${GATEWAY}/ipfs/`],
    [`${GATEWAY}/other/abc.png`],
    [`${GATEWAY}/ipfsx/abc`],
    ['http://media.6529.io/ipfs/abc'],
    ['https://media.6529.io:444/ipfs/abc'],
    ['https://media.6529.io.example.com/ipfs/abc'],
    ['https://evilmedia.6529.io/ipfs/abc'],
    ['https://media.6529.io@example.com/ipfs/abc'],
    ['https://user@media.6529.io/ipfs/abc'],
    ['https://media.6529.io/ipfs/../pfp/abc']
  ])('rejects %p', (url) => {
    expect(isAllowedPushNotificationImageUrl(url as string | undefined)).toBe(
      false
    );
  });

  it('rejects any URL on a host other than the media hosts', () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        const host = new URL(url).hostname;
        fc.pre(
          host !== 'd3lqz0a4bldqgf.cloudfront.net' && host !== 'media.6529.io'
        );
        expect(isAllowedPushNotificationImageUrl(url)).toBe(false);
      })
    );
  });
});
