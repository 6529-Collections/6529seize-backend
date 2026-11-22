import {
  PROFILE_DOC_CMS_KEYS,
  profileDocCmsFields,
  readProfileDocCms
} from '@/profile-cms/chain/profile-doc-cms';
import {
  CHAIN_FIXTURE_PRINCIPAL,
  encodeTestProfileDoc
} from '@/tests/fixtures/profile-cms-chain.fixture';

const PUBLICATION =
  'bafkreie5cyyazg2mwjwk7foh6qhhev4ize3dkpz5656e6ty6sjn4zyfzjq';
const PACKAGE = 'bafkreiej3lbdjacakabv566nmsdidmktb6sxt765d7skg2sakrog2ttsiq';
const ARCHIVE = 'bafkreiedy57oyhdigsburvrwepydy4i4guk6q3th5b7w42szehbt672tgm';
// PACKAGE with the last character's two spare bits set: the same 36 bytes,
// but not the canonical text, so readers must refuse it.
const PACKAGE_NONCANONICAL = `${PACKAGE.slice(0, -1)}r`;

describe('readProfileDocCms', () => {
  it('uses the ProfileDoc.v1 key names', () => {
    expect(PROFILE_DOC_CMS_KEYS).toEqual({
      publication: 'cms.primary.publication',
      package: 'cms.primary.package',
      archive: 'cms.archive'
    });
  });

  it('reads a document without the keys as no site', () => {
    expect(readProfileDocCms({ displayName: 'x' })).toEqual({
      ok: true,
      cms: null
    });
  });

  it('reads a site and its archive', () => {
    expect(
      readProfileDocCms({
        'cms.archive': ARCHIVE,
        'cms.primary.package': PACKAGE,
        'cms.primary.publication': PUBLICATION
      })
    ).toEqual({
      ok: true,
      cms: {
        primary: { publication: PUBLICATION, package: PACKAGE },
        archive: ARCHIVE
      }
    });
  });

  it('reads an archive without a site (unpublished)', () => {
    expect(readProfileDocCms({ 'cms.archive': ARCHIVE })).toEqual({
      ok: true,
      cms: { primary: null, archive: ARCHIVE }
    });
  });

  it('ignores other keys, cms ones included', () => {
    expect(
      readProfileDocCms({
        'cms.primary.package': PACKAGE,
        'cms.primary.publication': PUBLICATION,
        'cms.theme': 'dark',
        bio: 'hello'
      })
    ).toEqual({
      ok: true,
      cms: {
        primary: { publication: PUBLICATION, package: PACKAGE },
        archive: null
      }
    });
  });

  it('reads a broken archive value as no archive', () => {
    expect(
      readProfileDocCms({
        'cms.archive': 'ar://abc',
        'cms.primary.package': PACKAGE,
        'cms.primary.publication': PUBLICATION
      })
    ).toEqual({
      ok: true,
      cms: {
        primary: { publication: PUBLICATION, package: PACKAGE },
        archive: null
      }
    });
  });

  it.each([
    [
      'a publication without its package',
      { 'cms.primary.publication': PUBLICATION },
      'cms_primary_incomplete'
    ],
    [
      'a package without its publication',
      { 'cms.primary.package': PACKAGE, 'cms.archive': ARCHIVE },
      'cms_primary_incomplete'
    ],
    [
      'a gateway URL',
      {
        'cms.primary.package': PACKAGE,
        'cms.primary.publication': `https://x.test/${PUBLICATION}`
      },
      'cms_primary_invalid'
    ],
    [
      'an empty value',
      { 'cms.primary.package': '', 'cms.primary.publication': PUBLICATION },
      'cms_primary_invalid'
    ],
    [
      'non-canonical CID text',
      {
        'cms.primary.package': PACKAGE_NONCANONICAL,
        'cms.primary.publication': PUBLICATION
      },
      'cms_primary_invalid'
    ],
    [
      'a CID of another codec',
      {
        'cms.primary.package': PACKAGE,
        'cms.primary.publication': `bafybei${PUBLICATION.slice(7)}`
      },
      'cms_primary_invalid'
    ]
  ])('refuses %s', (_name, fields, reason) => {
    expect(readProfileDocCms(fields)).toEqual({ ok: false, reason });
  });

  it('writes the keys and reads them back', () => {
    const cms = {
      primary: { publication: PUBLICATION, package: PACKAGE },
      archive: null
    };
    expect(profileDocCmsFields(cms)).toEqual({
      'cms.primary.package': PACKAGE,
      'cms.primary.publication': PUBLICATION
    });
    expect(readProfileDocCms(profileDocCmsFields(cms))).toEqual({
      ok: true,
      cms
    });
    expect(profileDocCmsFields({ primary: null, archive: ARCHIVE })).toEqual({
      'cms.archive': ARCHIVE
    });
  });
});

/**
 * Through the identity mirror's CE decoder (`src/identity-chain-mirror/
 * profile-doc.ts`, branch claude/identity-reads-from-chain): the fields it
 * decodes from a ProfileDoc.v1's bytes, and its own `profileDocCms`, must
 * read the same site as this module. The decoder isn't on this branch yet,
 * so the block runs once both branches meet (integration, then main) and is
 * skipped until then. With PROFILE_CMS_REQUIRE_IDENTITY_DECODER=true (set it
 * in CI once both are on main) a missing decoder fails instead.
 */
const identityMirror = loadIdentityMirrorDecoder();
const decoderRequired =
  process.env.PROFILE_CMS_REQUIRE_IDENTITY_DECODER === 'true';

(identityMirror || decoderRequired ? describe : describe.skip)(
  "the identity mirror's ProfileDoc decoder",
  () => {
    const docs: [string, Record<string, string>][] = [
      [
        'a site and an archive',
        {
          displayName: 'testhandle',
          'cms.archive': ARCHIVE,
          'cms.primary.package': PACKAGE,
          'cms.primary.publication': PUBLICATION
        }
      ],
      ['an archive only', { 'cms.archive': ARCHIVE, website: 'x.test' }],
      ['no site', { displayName: 'testhandle' }],
      ['a lone package', { 'cms.primary.package': PACKAGE }],
      [
        'non-canonical CID text',
        {
          'cms.primary.package': PACKAGE_NONCANONICAL,
          'cms.primary.publication': PUBLICATION
        }
      ]
    ];

    it.each(docs)('reads %s the same way', (_name, fields) => {
      if (!identityMirror) {
        throw new Error(
          "The identity mirror's ProfileDoc decoder is required here and was not found"
        );
      }
      const mirror = identityMirror;
      const decoded = mirror.decodeCeProfileDoc(
        encodeTestProfileDoc({
          principal: CHAIN_FIXTURE_PRINCIPAL,
          version: 1,
          fields
        })
      );
      expect(decoded).toEqual(fields);
      const read = readProfileDocCms(decoded);
      const theirs = mirror.profileDocCms(decoded);
      if (read.ok) {
        expect(theirs).toEqual(read.cms);
      } else {
        // A lone or broken site key: no site on either side.
        expect(theirs?.primary ?? null).toBeNull();
      }
    });
  }
);

interface IdentityMirrorDecoder {
  decodeCeProfileDoc(bytes: Buffer): Record<string, string>;
  profileDocCms(fields: Record<string, string>): {
    primary: { publication: string; package: string } | null;
    archive: string | null;
  } | null;
}

function loadIdentityMirrorDecoder(): IdentityMirrorDecoder | null {
  try {
    // A computed path: the module joins this branch at the merge.
    return require(['@', 'identity-chain-mirror', 'profile-doc'].join('/'));
  } catch {
    return null;
  }
}
