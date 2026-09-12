import { createHash } from 'node:crypto';
import {
  ARTWORK_FORMATS,
  ARTWORK_UPLOAD_POLICY,
  assetClass,
  publicationAssetAccess,
  canReadAsset,
  canReadOriginal,
  expectedPartSize,
  requirePublicationAsset,
  validatePublicationAssetLink,
  validateAssetParts,
  validateStartUpload
} from '@/artwork-documentation/assets/artwork-assets.policy';
import {
  anArtworkAsset,
  artistAssetAccess
} from '@/artwork-documentation/assets/artwork-assets.test-support';
import { dossierFixture } from '@/artwork-documentation/museum/export/dossier-fixture';

const checksum = createHash('sha256')
  .update('last short part')
  .digest('base64');
describe('artwork archive policy', () => {
  const publicationAccess = { publicationOnly: true };
  it.each(['consent_instrument', 'rights_instrument'] as const)(
    'accepts a public v3 %s before a media profile has been answered',
    (role) => {
      const context = dossierFixture().snapshot.context;
      delete context.modules.artwork.media_profiles;
      const access = publicationAssetAccess(context);
      const input = {
        filename: 'instrument.pdf',
        size_bytes: 9,
        declared_mime: 'application/pdf',
        role,
        intended_visibility: 'public_record' as const
      };
      expect(access.publicationOnlyV3).toBe(true);
      expect(assetClass(role, access)).toBe('artwork');
      expect(validateStartUpload(input, access)).toBe('pdf');
      expect(() => requirePublicationAsset(access, input)).not.toThrow();
      expect(() =>
        requirePublicationAsset(access, {
          ...input,
          intended_visibility: 'restricted'
        })
      ).toThrow('publication_visibility_required');
      context.profile = { ...context.profile, version: 2 };
      const legacy = publicationAssetAccess(context);
      expect(assetClass(role, legacy)).toBe('rights_evidence');
      expect(() => validateStartUpload(input, legacy)).toThrow(
        'rights_evidence_is_restricted'
      );
    }
  );
  it.each([
    'camera_original',
    'working_file',
    'consent_instrument',
    'rights_instrument'
  ])('rejects private-source role %s for publication-only intake', (role) => {
    expect(() =>
      requirePublicationAsset(publicationAccess, {
        role,
        intended_visibility: 'public_record'
      })
    ).toThrow('publication_asset_role_required');
    expect(() =>
      requirePublicationAsset(
        {},
        {
          role,
          intended_visibility: 'restricted'
        }
      )
    ).not.toThrow();
  });
  it('rejects restricted visibility and private deposit terms in a public role', () => {
    expect(() =>
      requirePublicationAsset(publicationAccess, {
        role: 'artwork_final',
        intended_visibility: 'restricted'
      })
    ).toThrow('publication_visibility_required');
    expect(() =>
      validatePublicationAssetLink(publicationAccess, {
        role: 'preservation_master',
        intended_visibility: 'public_record',
        intended_terms: { kind: 'private_deposit' }
      })
    ).toThrow('publication_asset_terms_required');
    expect(() =>
      validatePublicationAssetLink(publicationAccess, {
        role: 'preservation_master',
        intended_visibility: 'public_record',
        intended_terms: { kind: 'unspecified' }
      })
    ).not.toThrow();
  });
  it('validates stored manifest eligibility independently of the role link', () => {
    expect(() =>
      validatePublicationAssetLink(publicationAccess, {
        role: 'other_supporting',
        intended_visibility: 'public_record',
        intended_terms: { kind: 'unspecified' },
        manifest: { role: 'working_file', intended_visibility: 'public_record' }
      })
    ).toThrow('publication_asset_role_required');
  });
  it('requires separate publication permission for each interview medium', () => {
    expect(() =>
      requirePublicationAsset(publicationAccess, {
        role: 'interview_recording',
        intended_visibility: 'public_record'
      })
    ).toThrow('interview_publication_permission_required');
    expect(() =>
      requirePublicationAsset(
        { ...publicationAccess, canPublishInterviewRecording: true },
        {
          role: 'interview_recording',
          intended_visibility: 'public_record'
        }
      )
    ).not.toThrow();
    expect(() =>
      requirePublicationAsset(
        { ...publicationAccess, canPublishInterviewRecording: true },
        {
          role: 'interview_transcript',
          intended_visibility: 'public_record'
        }
      )
    ).toThrow('interview_publication_permission_required');
  });
  it('permits 8GiB masters and rejects one byte beyond', () => {
    const input = {
      filename: 'master.tiff',
      size_bytes: 8 * 1024 ** 3,
      declared_mime: 'image/tiff',
      role: 'preservation_master' as const,
      intended_visibility: 'restricted' as const
    };
    expect(validateStartUpload(input)).toBe('tiff');
    expect(() =>
      validateStartUpload({ ...input, size_bytes: input.size_bytes + 1 })
    ).toThrow('asset_size_limit');
  });
  it.each(['html', 'svg', 'exe', 'zip', 'rar'])(
    'rejects active/archive extension %s regardless of MIME',
    (extension) => {
      expect(() =>
        validateStartUpload({
          filename: `file.${extension}`,
          size_bytes: 3,
          declared_mime: 'image/png',
          role: 'working_file',
          intended_visibility: 'restricted'
        })
      ).toThrow('unsupported_file_format');
    }
  );
  it('registers concrete vendor RAW formats, not an unbounded wildcard', () => {
    expect(
      ['cr2', 'cr3', 'nef', 'nrw', 'arw', 'raf', 'orf', 'rw2', 'dng'].every(
        (ext) => Boolean(ARTWORK_FORMATS[ext])
      )
    ).toBe(true);
    expect(ARTWORK_FORMATS.raw).toBeUndefined();
  });
  it('locks all rights instruments to restricted storage and permissions', () => {
    expect(() =>
      validateStartUpload({
        filename: 'consent.pdf',
        size_bytes: 9,
        declared_mime: 'application/pdf',
        role: 'consent_instrument',
        intended_visibility: 'public_record'
      })
    ).toThrow('rights_evidence_is_restricted');
    const asset = anArtworkAsset({
      access_class: 'rights_evidence',
      intended_visibility: 'restricted'
    });
    const reviewer = { ...artistAssetAccess, canReadRightsEvidence: false };
    expect(canReadAsset(asset, reviewer)).toBe(false);
    expect(canReadOriginal(asset, reviewer)).toBe(false);
  });
  it('ordinary context access does not confer original byte download', () => {
    const asset = anArtworkAsset();
    const reader = { ...artistAssetAccess, canReadArchivalFiles: false };
    expect(canReadAsset(asset, reader)).toBe(true);
    expect(canReadOriginal(asset, reader)).toBe(false);
  });
  it('requires canonical SHA256 checksums and exact ordered completion including the short final part', () => {
    const size = ARTWORK_UPLOAD_POLICY.part_size_bytes + 3;
    validateAssetParts(
      [
        { part_number: 1, checksum_sha256: checksum },
        { part_number: 2, checksum_sha256: checksum }
      ],
      size,
      true
    );
    expect(expectedPartSize(2, size)).toBe(3);
    expect(() =>
      validateAssetParts(
        [{ part_number: 1, checksum_sha256: checksum }],
        size,
        true
      )
    ).toThrow('invalid_upload_parts');
    expect(() =>
      validateAssetParts(
        [{ part_number: 1, checksum_sha256: 'deadbeef' }],
        size
      )
    ).toThrow('invalid_part_checksum');
    expect(() =>
      validateAssetParts(
        [
          { part_number: 2, checksum_sha256: checksum },
          { part_number: 1, checksum_sha256: checksum }
        ],
        size,
        true
      )
    ).toThrow('invalid_upload_parts');
  });
});
