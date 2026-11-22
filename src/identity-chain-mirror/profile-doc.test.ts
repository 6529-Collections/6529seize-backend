import { createHash } from 'node:crypto';
import {
  decodeCeProfileDoc,
  decodeProfileDoc,
  PROFILE_DOC_SCHEMA,
  isCmsCid,
  ProfileDocError,
  profileDocCms,
  toProfileDocFields
} from './profile-doc';

// The vectors shared with src/profile-cms/chain/profile-doc-cms.test.ts.
const CID1 = 'bafkreie5cyyazg2mwjwk7foh6qhhev4ize3dkpz5656e6ty6sjn4zyfzjq';
const CID2 = 'bafkreiej3lbdjacakabv566nmsdidmktb6sxt765d7skg2sakrog2ttsiq';
const CID3 = 'bafkreiedy57oyhdigsburvrwepydy4i4guk6q3th5b7w42szehbt672tgm';
// CID2 with a spare bit of its last character set: the same 36 bytes, but
// not the canonical text.
const CID2_NONCANONICAL = `${CID2.slice(0, -1)}r`;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** CID text built bit by bit, independently of the code under test. */
function cidText(bytes: Buffer): string {
  const bits = Array.from(bytes)
    .map((it) => it.toString(2).padStart(8, '0'))
    .join('');
  const padded = bits.padEnd(Math.ceil(bits.length / 5) * 5, '0');
  let text = 'b';
  for (let i = 0; i < padded.length; i += 5) {
    text += ALPHABET[Number.parseInt(padded.slice(i, i + 5), 2)];
  }
  return text;
}

/** The same text with each non-zero value of the last character's spare bits. */
function spareBitVariants(cid: string): string[] {
  const last = ALPHABET.indexOf(cid[cid.length - 1]);
  return [1, 2, 3].map((spare) => cid.slice(0, -1) + ALPHABET[last | spare]);
}

function rawSha256Cid(digest: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
}

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

  it('reads only canonical raw sha2-256 CIDs', () => {
    expect([CID1, CID2, CID3].every(isCmsCid)).toBe(true);
    expect(spareBitVariants(CID2)[0]).toBe(CID2_NONCANONICAL);
    for (const text of [
      ...[CID1, CID2, CID3].flatMap(spareBitVariants),
      `bafybei${CID1.slice(7)}`, // codec dag-pb
      'bafkrgie5cyyazg2mwjwk7foh6qhhev4ize3dkpz5656e6ty6sjn4zyfzjq', // multihash 0x13
      'bafkreim5cyyazg2mwjwk7foh6qhhev4ize3dkpz5656e6ty6sjn4zyfzjq', // length 0x21
      'bajkreie5cyyazg2mwjwk7foh6qhhev4ize3dkpz5656e6ty6sjn4zyfzjq', // version 2
      CID1.toUpperCase(),
      CID1.slice(0, -1),
      `${CID1}a`,
      `z${CID1.slice(1)}`,
      ` ${CID1}`,
      ''
    ]) {
      expect([text, isCmsCid(text)]).toEqual([text, false]);
    }
  });

  it('agrees with an independent encoder on many digests', () => {
    for (let i = 0; i < 256; i++) {
      const digest = createHash('sha256').update(`digest ${i}`).digest();
      const cid = cidText(rawSha256Cid(digest));
      expect([cid, isCmsCid(cid)]).toEqual([cid, true]);
      for (const variant of spareBitVariants(cid)) {
        expect([variant, isCmsCid(variant)]).toEqual([variant, false]);
      }
    }
  });

  it('serves no site from non-canonical CID text', () => {
    expect(
      profileDocCms({
        'cms.primary.publication': CID1,
        'cms.primary.package': CID2_NONCANONICAL
      })
    ).toBeNull();
    expect(profileDocCms({ 'cms.archive': CID2_NONCANONICAL })).toBeNull();
    // A good archive stays beside a refused site.
    expect(
      profileDocCms({
        'cms.primary.publication': CID1,
        'cms.primary.package': CID2_NONCANONICAL,
        'cms.archive': CID3
      })
    ).toEqual({ primary: null, archive: CID3 });
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
