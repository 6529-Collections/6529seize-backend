import { createHash } from 'node:crypto';
import {
  ARTWORK_FORMATS,
  ARTWORK_UPLOAD_POLICY,
  canReadAsset,
  canReadOriginal,
  expectedPartSize,
  validateAssetParts,
  validateStartUpload
} from '@/artwork-documentation/assets/artwork-assets.policy';
import {
  anArtworkAsset,
  artistAssetAccess
} from '@/artwork-documentation/assets/artwork-assets.test-support';

const checksum = createHash('sha256')
  .update('last short part')
  .digest('base64');
describe('artwork archive policy', () => {
  it('permits real 4GiB masters and rejects one byte beyond', () => {
    const input = {
      filename: 'master.tiff',
      size_bytes: 4 * 1024 ** 3,
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
