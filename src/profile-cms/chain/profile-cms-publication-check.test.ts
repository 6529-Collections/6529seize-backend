import { cmsCidFromBytes } from '@/profile-cms/chain/profile-cms-cid';
import { checkProfileCmsPublication } from '@/profile-cms/chain/profile-cms-publication-check';
import { canonicalizeJson } from '@/profile-cms/protocol/v1';
import {
  aSignedProfileSite,
  CHAIN_FIXTURE_OTHER_WALLET,
  CHAIN_FIXTURE_PROFILE_ID,
  CHAIN_FIXTURE_WALLET,
  SignedSiteFixture
} from '@/tests/fixtures/profile-cms-chain.fixture';

const WALLETS = [CHAIN_FIXTURE_WALLET.address.toLowerCase()];
const SET_AT = Date.parse('2026-11-25T01:00:00.000Z');

function input(site: SignedSiteFixture, overrides = {}) {
  return {
    primary: { publication: site.publicationCid, package: site.coreCid },
    publicationBytes: site.publicationBytes,
    packageBytes: site.coreBytes,
    profileId: CHAIN_FIXTURE_PROFILE_ID,
    wallets: WALLETS,
    checkedAtMs: SET_AT,
    ...overrides
  };
}

function withPublication(
  site: SignedSiteFixture,
  edit: (publication: Record<string, any>) => void
): {
  publicationBytes: Buffer;
  primary: { publication: string; package: string };
} {
  const publication = JSON.parse(site.publicationBytes.toString('utf8'));
  edit(publication);
  const publicationBytes = Buffer.from(canonicalizeJson(publication));
  return {
    publicationBytes,
    primary: {
      publication: cmsCidFromBytes(publicationBytes),
      package: site.coreCid
    }
  };
}

describe('checkProfileCmsPublication', () => {
  let site: SignedSiteFixture;

  beforeAll(async () => {
    site = await aSignedProfileSite();
  });

  it('accepts a signed publication and rebuilds the served package', async () => {
    const result = await checkProfileCmsPublication(input(site));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { checked } = result;
    expect(checked.cms_package).toEqual(site.cmsPackage);
    expect(checked.signer_address).toBe(WALLETS[0]);
    expect(checked.typed_data_hash).toBe(site.typedDataHash);
    expect(checked.canonical_receipt.uri).toBe(`ar://${'a'.repeat(43)}`);
    expect(checked.validation_result.valid).toBe(true);
    expect(checked.validation_result.checked_at).toBe(
      '2026-11-25T01:00:00.000Z'
    );
    expect(checked.publication.package_db_id).toBe('draft-1');
  });

  it('keeps an expired deadline valid: it only limited live publishing', async () => {
    const result = await checkProfileCmsPublication(
      input(site, { checkedAtMs: SET_AT + 10 * 365 * 86_400_000 })
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    [
      'a missing publication',
      { publicationBytes: null },
      'publication_not_found'
    ],
    ['a missing package', { packageBytes: null }, 'package_not_found'],
    [
      'publication bytes that do not match the CID',
      { publicationBytes: Buffer.from('other') },
      'publication_cid_mismatch'
    ],
    [
      'package bytes that do not match the CID',
      { packageBytes: Buffer.from('other') },
      'package_cid_mismatch'
    ],
    [
      'another profile',
      { profileId: 'test-profile-2' },
      'publication_for_another_profile'
    ],
    [
      'a signer outside the profile',
      { wallets: [CHAIN_FIXTURE_OTHER_WALLET.address.toLowerCase()] },
      'signer_not_in_profile'
    ]
  ])('refuses %s', async (_name, overrides, reason) => {
    expect(await checkProfileCmsPublication(input(site, overrides))).toEqual({
      ok: false,
      reason
    });
  });

  it('refuses a package the publication does not sign', async () => {
    const other = await aSignedProfileSite({ title: 'Another site' });
    expect(
      await checkProfileCmsPublication(
        input(site, {
          primary: { publication: site.publicationCid, package: other.coreCid },
          packageBytes: other.coreBytes
        })
      )
    ).toEqual({ ok: false, reason: 'package_cid_not_signed' });
  });

  it('refuses package bytes that are not canonical JSON', async () => {
    const loose = Buffer.from(
      JSON.stringify(JSON.parse(site.coreBytes.toString()), null, 2)
    );
    expect(
      await checkProfileCmsPublication(
        input(site, {
          primary: {
            publication: site.publicationCid,
            package: cmsCidFromBytes(loose)
          },
          packageBytes: loose
        })
      )
    ).toEqual({ ok: false, reason: 'package_not_canonical' });
  });

  it('refuses a publication whose signed message names another draft', async () => {
    const edited = withPublication(site, (publication) => {
      publication.package_db_id = 'draft-2';
    });
    expect(await checkProfileCmsPublication(input(site, edited))).toEqual({
      ok: false,
      reason: 'publication_bindings_mismatch'
    });
  });

  it('refuses a forged signature', async () => {
    const edited = withPublication(site, (publication) => {
      publication.typed_data.message.version = 7;
      publication.version = 7;
    });
    const result = await checkProfileCmsPublication(input(site, edited));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^signature_/);
  });

  it('refuses a publication with unknown fields', async () => {
    const edited = withPublication(site, (publication) => {
      publication.note = 'extra';
    });
    expect(await checkProfileCmsPublication(input(site, edited))).toEqual({
      ok: false,
      reason: 'publication_schema_invalid'
    });
  });

  it('refuses an envelope without a decentralized canonical receipt', async () => {
    const edited = withPublication(site, (publication) => {
      publication.package_envelope.storage = [
        {
          ...publication.package_envelope.storage[0],
          provider: 's3',
          uri: 'https://example.test/package.json'
        }
      ];
    });
    const result = await checkProfileCmsPublication(input(site, edited));
    expect(result.ok).toBe(false);
  });
});
