import fc from 'fast-check';
import {
  cmsCidFromBytes,
  cmsCidFromHash,
  cmsCidMatchesBytes,
  cmsHashFromCid,
  isCmsCid
} from '@/profile-cms/chain/profile-cms-cid';

// The vectors in the ProfileDoc profile site field text (PROFILEDOC-FIELD.md).
const VECTORS = [
  {
    bytes: 'example publication',
    hash: 'sha256:9d16300c9b4cb26caf95c7f40e725788c936353f3df77c4f4f1e925bcce0b94c',
    cid: 'bafkreie5cyyazg2mwjwk7foh6qhhev4ize3dkpz5656e6ty6sjn4zyfzjq'
  },
  {
    bytes: 'example package',
    hash: 'sha256:89dac234804050035efbcd648681b1530fa579ffdd1fe4a36a40545c6d4e7244',
    cid: 'bafkreiej3lbdjacakabv566nmsdidmktb6sxt765d7skg2sakrog2ttsiq'
  },
  {
    bytes: 'example archive',
    hash: 'sha256:83c77eec1c68348348d63623f03c711c3515e86e67e87f6e6a5921c33f7f5333',
    cid: 'bafkreiedy57oyhdigsburvrwepydy4i4guk6q3th5b7w42szehbt672tgm'
  }
];

describe('profile site CIDs', () => {
  it.each(VECTORS)('matches the field text vector for "$bytes"', (vector) => {
    const bytes = Buffer.from(vector.bytes, 'utf8');
    expect(cmsCidFromBytes(bytes)).toBe(vector.cid);
    expect(cmsCidFromHash(vector.hash)).toBe(vector.cid);
    expect(cmsHashFromCid(vector.cid)).toBe(vector.hash);
    expect(cmsCidMatchesBytes(vector.cid, bytes)).toBe(true);
    expect(cmsCidMatchesBytes(vector.cid, Buffer.from('other'))).toBe(false);
  });

  it('round-trips every sha256 digest', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (digest) => {
        const hash = `sha256:${Buffer.from(digest).toString('hex')}`;
        const cid = cmsCidFromHash(hash);
        return isCmsCid(cid) && cmsHashFromCid(cid) === hash;
      })
    );
  });

  it.each([
    ['upper case', VECTORS[0].cid.toUpperCase()],
    ['no multibase prefix', VECTORS[0].cid.slice(1)],
    [
      'a dag-pb CIDv1',
      'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
    ],
    ['a CIDv0', 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'],
    ['truncated', VECTORS[0].cid.slice(0, -2)],
    ['trailing bits set', `${VECTORS[0].cid.slice(0, -1)}r`],
    ['empty', '']
  ])('refuses %s', (_name, value) => {
    expect(isCmsCid(value)).toBe(false);
    expect(cmsHashFromCid(value)).toBeNull();
  });

  it('refuses a hash that is not sha256', () => {
    expect(() => cmsCidFromHash('sha256:abc')).toThrow();
  });
});
