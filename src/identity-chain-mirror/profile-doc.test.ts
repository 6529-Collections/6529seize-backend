import {
  decodeCeProfileDoc,
  decodeProfileDoc,
  PROFILE_DOC_SCHEMA,
  ProfileDocError,
  profileDocCms,
  toProfileDocFields
} from './profile-doc';

const CID = (c: string) => `bafkrei${c.repeat(52)}`;
const CID1 = CID('a');
const CID2 = CID('b');
const CID3 = CID('c');

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function str(s: string | Buffer): Buffer {
  const bytes = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
  return Buffer.concat([u32(bytes.length), bytes]);
}

/** A ProfileDoc.v1 in CE, keys in the order given. */
function ceDoc(
  fields: [string, string][],
  { schema = PROFILE_DOC_SCHEMA, trailing = Buffer.alloc(0) } = {}
): Buffer {
  return Buffer.concat([
    str(schema),
    Buffer.alloc(32, 0xab),
    u32(1),
    str(Buffer.alloc(0)),
    Buffer.alloc(32, 0x11),
    u32(fields.length),
    ...fields.flatMap(([k, v]) => [str(k), str(v)]),
    str(Buffer.alloc(0)),
    trailing
  ]);
}

describe('ProfileDoc.v1', () => {
  const fields: [string, string][] = [
    ['avatar', 'ipfs://pfp'],
    ['banner1', '#112233'],
    ['bio', 'hello'],
    ['classification', 'PSEUDONYM'],
    ['statement.SOCIAL_MEDIA_ACCOUNT.X.0', 'alice'],
    ['statement.SOCIAL_MEDIA_ACCOUNT.X.0.comment', 'main'],
    ['statement.SOCIAL_MEDIA_ACCOUNT.X.1', 'alice2'],
    ['website', 'https://example.org']
  ];

  it('decodes the canonical bytes', () => {
    expect(decodeCeProfileDoc(ceDoc(fields))).toEqual(
      Object.fromEntries(fields)
    );
  });

  it.each([
    ['another schema', ceDoc(fields, { schema: '6529.Other.v1' })],
    ['trailing bytes', ceDoc(fields, { trailing: Buffer.from([0]) })],
    [
      'keys out of order',
      ceDoc([
        ['website', 'x'],
        ['avatar', 'y']
      ])
    ],
    ['truncated bytes', ceDoc(fields).subarray(0, 40)]
  ])('refuses %s', (_, bytes) => {
    expect(() => decodeCeProfileDoc(bytes)).toThrow(ProfileDocError);
  });

  it('reads a JSON document too', () => {
    expect(
      decodeProfileDoc(
        Buffer.from(JSON.stringify({ fields: { avatar: 'a', n: 1 } }))
      )
    ).toEqual({ avatar: 'a' });
    expect(decodeProfileDoc(Buffer.from('{"website":"w"}'))).toEqual({
      website: 'w'
    });
    expect(() => decodeProfileDoc(Buffer.from('not a doc'))).toThrow(
      ProfileDocError
    );
  });

  it('maps the fields to 6529.io columns and statements', () => {
    expect(
      toProfileDocFields({
        ...Object.fromEntries(fields),
        displayName: 'Alice',
        'cms.primary.publication': CID1,
        'cms.primary.package': CID2,
        'statement.GENERAL.BIO.0': 'about me',
        'statement.SOCIAL_MEDIA_ACCOUNT.X.2': ''
      })
    ).toEqual({
      cms: { primary: { publication: CID1, package: CID2 }, archive: null },
      displayName: 'Alice',
      pfp: 'ipfs://pfp',
      banner1: '#112233',
      banner2: null,
      website: 'https://example.org',
      classification: 'PSEUDONYM',
      subClassification: null,
      statements: [
        { group: 'GENERAL', type: 'BIO', value: 'hello', comment: null },
        { group: 'GENERAL', type: 'BIO', value: 'about me', comment: null },
        {
          group: 'SOCIAL_MEDIA_ACCOUNT',
          type: 'X',
          value: 'alice',
          comment: 'main'
        },
        {
          group: 'SOCIAL_MEDIA_ACCOUNT',
          type: 'X',
          value: 'alice2',
          comment: null
        }
      ]
    });
  });
});

describe('profileDocCms', () => {
  it('rebuilds the profile site from its three keys', () => {
    expect(
      profileDocCms({
        'cms.primary.publication': CID1,
        'cms.primary.package': CID2,
        'cms.archive': CID3
      })
    ).toEqual({
      primary: { publication: CID1, package: CID2 },
      archive: CID3
    });
    expect(profileDocCms({ 'cms.archive': CID3 })).toEqual({
      primary: null,
      archive: CID3
    });
  });

  it('serves no site from a lone or malformed CID', () => {
    expect(profileDocCms({ 'cms.primary.package': CID2 })).toBeNull();
    expect(
      profileDocCms({
        'cms.primary.publication': 'ipfs://x',
        'cms.primary.package': CID2
      })
    ).toBeNull();
    expect(profileDocCms({})).toBeNull();
  });
});
