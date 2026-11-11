import fc from 'fast-check';
import { Logger } from '@/logging';
import { BadRequestException } from '@/exceptions';
import {
  assertProfilePictureUrlChangeAllowed,
  describeIpfsUrlShape,
  isBareCidIpfsUrl,
  isMediaHostUrl,
  ProfilePictureUrlSchema
} from './profile-picture-url';

const schema = ProfilePictureUrlSchema.optional().allow(null).default(null);

const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const CID_V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

/**
 * What POST /profiles does with a picture URL the profile does not have yet:
 * the request schema, then the checks for a changed value.
 */
function validate(
  value: unknown,
  stored: Array<string | null> = []
): { value?: unknown; error?: string } {
  const result = schema.validate(value);
  if (result.error) {
    return { value: result.value, error: result.error.message };
  }
  try {
    assertProfilePictureUrlChangeAllowed(result.value, stored);
  } catch (error) {
    return { value: result.value, error: (error as Error).message };
  }
  return { value: result.value, error: undefined };
}

const warn = jest.fn();

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(warn);
});

beforeEach(() => {
  warn.mockClear();
  delete process.env.PROFILE_PICTURE_IPFS_URLS_STRICT;
});

afterAll(() => {
  jest.restoreAllMocks();
  delete process.env.PROFILE_PICTURE_IPFS_URLS_STRICT;
});

describe('profile picture URLs on the media host', () => {
  it.each([
    'https://d3lqz0a4bldqgf.cloudfront.net/images/scaled_x450/0x33fd426905f149f8376e227d0c9d3340aad17af1/1.WEBP',
    'https://d3lqz0a4bldqgf.cloudfront.net/pfp/production/0b6b5b8e-9b7a-4f0e-8a51-3a7a3c1f6f5d.webp?d=1731196800000',
    'https://d3lqz0a4bldqgf.cloudfront.net/drops/author_1/picture.png'
  ])('accepts %s', (url) => {
    expect(validate(url)).toEqual({ value: url, error: undefined });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['a longer host name', 'https://d3lqz0a4bldqgf.example.com/pfp.png'],
    [
      'a host that only starts like the media host',
      'https://d3lqz0a4bldqgf.cloudfront.net.example/pfp.png'
    ],
    ['a different separator', 'https://d3lqz0a4bldqgf-cloudfront.net/pfp.png'],
    ['userinfo', 'https://d3lqz0a4bldqgf@example.com/pfp.png'],
    [
      'userinfo naming the media host',
      'https://d3lqz0a4bldqgf.cloudfront.net@example.com/pfp.png'
    ],
    ['a port', 'https://d3lqz0a4bldqgf.cloudfront.net:8443/pfp.png'],
    ['plain http', 'http://d3lqz0a4bldqgf.cloudfront.net/pfp.png'],
    ['no path', 'https://d3lqz0a4bldqgf.cloudfront.net'],
    ['an empty path', 'https://d3lqz0a4bldqgf.cloudfront.net/'],
    ['whitespace', 'https://d3lqz0a4bldqgf.cloudfront.net/a b.png'],
    ['another host', 'https://example.com/pfp.png'],
    ['a data URL', 'data:image/png;base64,AAAA'],
    ['an empty string', '']
  ])('rejects %s', (_, url) => {
    expect(validate(url).error).toBeDefined();
  });

  it('accepts null and a missing value', () => {
    expect(validate(null)).toEqual({ value: null, error: undefined });
    expect(validate(undefined)).toEqual({ value: null, error: undefined });
  });

  it('accepts no https URL whose host is not exactly the media host', () => {
    fc.assert(
      fc.property(fc.webUrl({ validSchemes: ['https'] }), (url) => {
        const parsed = new URL(url);
        fc.pre(parsed.hostname !== 'd3lqz0a4bldqgf.cloudfront.net');
        expect(isMediaHostUrl(url)).toBe(false);
      })
    );
  });

  it('accepts media host URLs with any non-empty path', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9._~/-]{1,40}$/), (path) => {
        expect(
          isMediaHostUrl(`https://d3lqz0a4bldqgf.cloudfront.net/${path}`)
        ).toBe(true);
      })
    );
  });
});

describe('profile picture ipfs:// URLs', () => {
  it.each([CID_V0, CID_V1])(
    'accepts the bare CID %s without logging',
    (cid) => {
      expect(validate(`ipfs://${cid}`)).toEqual({
        value: `ipfs://${cid}`,
        error: undefined
      });
      expect(warn).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['ipfs_path_prefix', `ipfs://ipfs/${CID_V0}`],
    ['cid_with_path', `ipfs://${CID_V1}/pfp.png`],
    ['query_or_fragment', `ipfs://${CID_V0}?filename=pfp.png`],
    ['other_cid_form', 'ipfs://QmUploadedPicture'],
    ['other_cid_form', `ipfs://${CID_V1.toUpperCase()}`]
  ])(
    'still accepts, and logs, a %s value while the strict switch is off',
    (shape, url) => {
      expect(validate(url)).toEqual({ value: url, error: undefined });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain('[PROFILE_PICTURE_IPFS_FORM]');
      expect(JSON.parse(line.slice(line.indexOf('{')))).toEqual({
        outcome: 'accepted',
        shape,
        length: url.length
      });
      expect(describeIpfsUrlShape(url)).toBe(shape);
    }
  );

  it('rejects, and logs, the same values once the strict switch is on', () => {
    process.env.PROFILE_PICTURE_IPFS_URLS_STRICT = 'true';
    const url = `ipfs://${CID_V1}/pfp.png`;

    expect(validate(url).error).toBeDefined();
    const line = String(warn.mock.calls[0][0]);
    expect(JSON.parse(line.slice(line.indexOf('{'))).outcome).toBe('rejected');
  });

  it('keeps accepting bare CIDs once the strict switch is on', () => {
    process.env.PROFILE_PICTURE_IPFS_URLS_STRICT = 'true';

    expect(validate(`ipfs://${CID_V0}`).error).toBeUndefined();
    expect(validate(`ipfs://${CID_V1}`).error).toBeUndefined();
  });

  it.each(['ipfs://', 'ipfs:/QmX', 'IPFS://' + CID_V0, 'ipns://' + CID_V1])(
    'rejects %s, as before',
    (url) => {
      expect(validate(url).error).toBeDefined();
    }
  );

  it('recognises only Qm base58 CIDs of 46 characters and base32 CIDv1', () => {
    expect(isBareCidIpfsUrl(`ipfs://${CID_V0}`)).toBe(true);
    expect(isBareCidIpfsUrl(`ipfs://${CID_V0}0`)).toBe(false);
    expect(isBareCidIpfsUrl(`ipfs://${CID_V0.slice(0, -1)}`)).toBe(false);
    expect(isBareCidIpfsUrl(`ipfs://${CID_V0.slice(0, -1)}0`)).toBe(false);
    expect(isBareCidIpfsUrl(`ipfs://${CID_V1}`)).toBe(true);
    expect(isBareCidIpfsUrl(`ipfs://${CID_V1.slice(0, 40)}`)).toBe(false);
  });
});

describe('profile picture URLs already stored for the profile', () => {
  const lookAlike = 'https://d3lqz0a4bldqgf.cloudfront.net.example/pfp.png';
  const withUserinfo = 'https://d3lqz0a4bldqgf@example.com/pfp.png';

  it.each([lookAlike, withUserinfo])(
    'keeps accepting %s when it is resent unchanged',
    (url) => {
      expect(validate(url, [null, url])).toEqual({
        value: url,
        error: undefined
      });
    }
  );

  it('does not log or reject an unchanged ipfs:// value in strict mode', () => {
    process.env.PROFILE_PICTURE_IPFS_URLS_STRICT = 'true';
    const url = `ipfs://${CID_V1}/pfp.png`;

    expect(validate(url, [url]).error).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses the same value when it replaces a different stored picture', () => {
    expect(() =>
      assertProfilePictureUrlChangeAllowed(lookAlike, [
        'https://d3lqz0a4bldqgf.cloudfront.net/pfp/production/a.webp'
      ])
    ).toThrow(BadRequestException);
    expect(() =>
      assertProfilePictureUrlChangeAllowed(withUserinfo, [null, undefined])
    ).toThrow(BadRequestException);
  });

  it('accepts ordinary new values and a cleared picture whatever is stored', () => {
    expect(() =>
      assertProfilePictureUrlChangeAllowed(`ipfs://${CID_V0}`, [lookAlike])
    ).not.toThrow();
    expect(() =>
      assertProfilePictureUrlChangeAllowed(
        'https://d3lqz0a4bldqgf.cloudfront.net/pfp/production/b.webp',
        [lookAlike]
      )
    ).not.toThrow();
    expect(() =>
      assertProfilePictureUrlChangeAllowed(null, [lookAlike])
    ).not.toThrow();
  });

  it('still refuses values outside the previously accepted shape, stored or not', () => {
    for (const url of [
      'https://example.com/pfp.png',
      'data:image/png;base64,AA'
    ]) {
      expect(validate(url, [url]).error).toBeDefined();
    }
  });
});
