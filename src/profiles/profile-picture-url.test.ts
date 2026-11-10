import fc from 'fast-check';
import {
  isAllowedProfilePictureUpdate,
  isAllowedProfilePictureUrl,
  isAllowedPushNotificationImageUrl,
  PROFILE_MEDIA_HOST
} from './profile-picture-url';

const CID_V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

describe('isAllowedProfilePictureUrl', () => {
  it('uses the media CDN host', () => {
    expect(PROFILE_MEDIA_HOST).toBe('d3lqz0a4bldqgf.cloudfront.net');
  });

  it.each([
    `ipfs://${CID_V1}`,
    `ipfs://${CID_V0}`,
    `ipfs://${CID_V1}/pfp.png`,
    `ipfs://${CID_V1}/my%20avatar.png`,
    `ipfs://ipfs/${CID_V0}`,
    'https://d3lqz0a4bldqgf.cloudfront.net/pfp/production/a.webp?d=1700000000000',
    'https://d3lqz0a4bldqgf.cloudfront.net/images/scaled_x450/0x33fd/1.WEBP',
    'https://D3LQZ0A4BLDQGF.cloudfront.net/pfp/a.png'
  ])('accepts %s', (value) => {
    expect(isAllowedProfilePictureUrl(value)).toBe(true);
  });

  it.each([
    // look-alike hosts and host-prefix forms the old prefix regex accepted
    'https://d3lqz0a4bldqgf.cloudfront.net.example.com/a.png',
    'https://d3lqz0a4bldqgf.example.com/a.png',
    'https://d3lqz0a4bldqgfx.cloudfront.net/a.png',
    'https://d3lqz0a4bldqgf-cloudfront.net/a.png',
    // userinfo forms
    'https://d3lqz0a4bldqgf.cloudfront.net@example.com/a.png',
    'https://d3lqz0a4bldqgf@example.com/a.png',
    'https://user:pass@d3lqz0a4bldqgf.cloudfront.net/a.png',
    'https://user@d3lqz0a4bldqgf.cloudfront.net/a.png',
    // other schemes, ports and shapes
    'http://d3lqz0a4bldqgf.cloudfront.net/a.png',
    'https://d3lqz0a4bldqgf.cloudfront.net:8443/a.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'https://example.com/a.png',
    'ipfs://',
    'ipfs://short',
    `ipfs://${CID_V1}/../x`,
    `ipfs://${CID_V1}?filename=a.png`,
    `ipfs://${CID_V1}/a b.png`,
    `ipfs://evil.example/${CID_V1}`,
    ''
  ])('rejects %s', (value) => {
    expect(isAllowedProfilePictureUrl(value)).toBe(false);
  });

  it('rejects null and undefined', () => {
    expect(isAllowedProfilePictureUrl(null)).toBe(false);
    expect(isAllowedProfilePictureUrl(undefined)).toBe(false);
  });

  it('never accepts an https URL whose host is not exactly the CDN host', () => {
    fc.assert(
      fc.property(fc.webUrl({ validSchemes: ['https'] }), (url) => {
        const host = new URL(url).hostname;
        if (host !== PROFILE_MEDIA_HOST) {
          expect(isAllowedProfilePictureUrl(url)).toBe(false);
        }
      })
    );
  });

  it('never accepts a CDN-prefixed host with an appended label', () => {
    fc.assert(
      fc.property(fc.domain(), (suffix) => {
        expect(
          isAllowedProfilePictureUrl(
            `https://${PROFILE_MEDIA_HOST}.${suffix}/a.png`
          )
        ).toBe(false);
      })
    );
  });
});

describe('isAllowedProfilePictureUpdate', () => {
  const legacy = 'https://d3lqz0a4bldqgf.example.com/legacy.png';
  const cdn = 'https://d3lqz0a4bldqgf.cloudfront.net/pfp/a.webp';

  it('accepts an unchanged stored value that predates the allowlist', () => {
    expect(isAllowedProfilePictureUpdate(legacy, [legacy, legacy])).toBe(true);
    expect(isAllowedProfilePictureUpdate(legacy, [null, legacy])).toBe(true);
  });

  it('rejects changing to a value outside the allowlist', () => {
    expect(isAllowedProfilePictureUpdate(legacy, [cdn, cdn])).toBe(false);
    expect(isAllowedProfilePictureUpdate(legacy, [null, undefined])).toBe(
      false
    );
  });

  it('accepts changing to an allowed value or clearing it', () => {
    expect(isAllowedProfilePictureUpdate(cdn, [legacy, legacy])).toBe(true);
    expect(isAllowedProfilePictureUpdate(`ipfs://${CID_V1}`, [legacy])).toBe(
      true
    );
    expect(isAllowedProfilePictureUpdate(null, [legacy])).toBe(true);
    expect(isAllowedProfilePictureUpdate(undefined, [])).toBe(true);
  });
});

describe('isAllowedPushNotificationImageUrl', () => {
  it.each([
    ['https://d3lqz0a4bldqgf.cloudfront.net/pfp/a.webp', true],
    [' https://d3lqz0a4bldqgf.cloudfront.net/pfp/a.webp ', true],
    [`https://media.6529.io/ipfs/${CID_V1}`, true],
    [`https://media.6529.io/arweave/abc`, false],
    [`https://media.6529.io.example.com/ipfs/${CID_V1}`, false],
    [`https://media.6529.io@example.com/ipfs/${CID_V1}`, false],
    [`ipfs://${CID_V1}`, false],
    ['https://example.com/a.png', false],
    ['http://d3lqz0a4bldqgf.cloudfront.net/a.png', false],
    [undefined, false]
  ])('%s -> %s', (value, expected) => {
    expect(isAllowedPushNotificationImageUrl(value)).toBe(expected);
  });
});
