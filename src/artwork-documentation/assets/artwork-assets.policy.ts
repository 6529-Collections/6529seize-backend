import { CustomApiCompliantException } from '@/exceptions';
import {
  ARTWORK_ASSET_ROLES,
  AssetAccess,
  AssetClass,
  AssetPart,
  StartArtworkUpload,
  StoredAsset
} from '@/artwork-documentation/assets/artwork-assets.types';

export const ARTWORK_UPLOAD_POLICY = Object.freeze({
  max_asset_bytes: 4 * 1024 ** 3,
  context_quota_bytes: 20 * 1024 ** 3,
  max_assets: 100,
  max_concurrent_uploads: 5,
  part_size_bytes: 16 * 1024 ** 2,
  parallel_parts: 3,
  part_url_seconds: 600,
  download_url_seconds: 300,
  upload_lifetime_ms: 24 * 60 * 60 * 1000,
  orphan_lifetime_ms: 7 * 24 * 60 * 60 * 1000
});

export function assetError(status: number, code: string): never {
  throw new CustomApiCompliantException(
    status,
    `artwork_documentation.${code.toLowerCase()}`,
    code
  );
}

const IMAGE_MIMES: Record<string, string[]> = {
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  png: ['image/png'],
  tif: ['image/tiff'],
  tiff: ['image/tiff'],
  webp: ['image/webp'],
  gif: ['image/gif']
};
export const ARTWORK_FORMATS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    ...IMAGE_MIMES,
    heic: ['image/heic', 'image/heif'],
    heif: ['image/heif', 'image/heic'],
    dng: ['image/x-adobe-dng'],
    cr2: ['image/x-canon-cr2'],
    cr3: ['image/x-canon-cr3'],
    nef: ['image/x-nikon-nef'],
    nrw: ['image/x-nikon-nrw'],
    arw: ['image/x-sony-arw'],
    raf: ['image/x-fuji-raf'],
    orf: ['image/x-olympus-orf'],
    rw2: ['image/x-panasonic-rw2'],
    psd: ['image/vnd.adobe.photoshop', 'image/x-photoshop'],
    psb: ['image/vnd.adobe.photoshop', 'image/x-photoshop'],
    xmp: ['application/rdf+xml', 'application/xml', 'text/xml'],
    pdf: ['application/pdf'],
    txt: ['text/plain'],
    md: ['text/markdown', 'text/plain'],
    wav: ['audio/wav', 'audio/x-wav'],
    flac: ['audio/flac', 'audio/x-flac'],
    mp3: ['audio/mpeg'],
    m4a: ['audio/mp4', 'audio/x-m4a'],
    mp4: ['video/mp4'],
    mov: ['video/quicktime']
  });

export function assetClass(role: string): AssetClass {
  return role === 'consent_instrument' || role === 'rights_instrument'
    ? 'rights_evidence'
    : 'artwork';
}
export function validateStartUpload(input: StartArtworkUpload): string {
  if (
    typeof input.filename !== 'string' ||
    input.filename.length > 255 ||
    !input.filename.trim() ||
    /[/\\]/.test(input.filename) ||
    Array.from(input.filename).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    assetError(422, 'INVALID_FILENAME');
  const extension = input.filename.split('.').pop()?.toLowerCase() ?? '';
  const formats = ARTWORK_FORMATS[extension];
  if (!formats || !ARTWORK_ASSET_ROLES.includes(input.role))
    assetError(422, 'UNSUPPORTED_FILE_FORMAT');
  if (
    typeof input.declared_mime !== 'string' ||
    (!formats.includes(input.declared_mime.toLowerCase()) &&
      input.declared_mime !== 'application/octet-stream')
  )
    assetError(422, 'INVALID_DECLARED_MIME');
  if (!['public_record', 'restricted'].includes(input.intended_visibility))
    assetError(422, 'INVALID_ASSET_VISIBILITY');
  if (
    !Number.isSafeInteger(input.size_bytes) ||
    input.size_bytes < 1 ||
    input.size_bytes > ARTWORK_UPLOAD_POLICY.max_asset_bytes
  )
    assetError(413, 'ASSET_SIZE_LIMIT');
  if (
    ['artwork_final', 'display_derivative'].includes(input.role) &&
    !IMAGE_MIMES[extension]
  )
    assetError(422, 'INVALID_FORMAT_FOR_ROLE');
  if (
    assetClass(input.role) === 'rights_evidence' &&
    input.intended_visibility !== 'restricted'
  )
    assetError(422, 'RIGHTS_EVIDENCE_IS_RESTRICTED');
  return extension;
}
export function canReadAsset(asset: StoredAsset, access: AssetAccess): boolean {
  if (asset.access_class === 'rights_evidence')
    return access.canReadRightsEvidence;
  return (
    asset.intended_visibility !== 'restricted' ||
    access.canReadRestricted ||
    access.canReadArchivalFiles ||
    (asset.uploader_profile_id === access.actorProfileId &&
      access.canEdit &&
      !asset.referenced)
  );
}
export function canReadOriginal(
  asset: StoredAsset,
  access: AssetAccess
): boolean {
  return (
    canReadAsset(asset, access) &&
    (asset.access_class === 'rights_evidence'
      ? access.canReadRightsEvidence
      : access.canReadArchivalFiles)
  );
}
export function requireAssetWrite(access: AssetAccess, role?: string): void {
  if (!access.canEdit) assetError(403, 'ASSET_EDIT_FORBIDDEN');
  if (
    role &&
    assetClass(role) === 'rights_evidence' &&
    !access.canReadRightsEvidence
  )
    assetError(403, 'RIGHTS_EVIDENCE_FORBIDDEN');
}
export function validateAssetParts(
  parts: AssetPart[],
  size: number,
  complete = false
): void {
  const count = Math.ceil(size / ARTWORK_UPLOAD_POLICY.part_size_bytes);
  if (
    !Array.isArray(parts) ||
    parts.length < 1 ||
    parts.length > (complete ? count : 3) ||
    (complete && parts.length !== count)
  )
    assetError(422, 'INVALID_UPLOAD_PARTS');
  const seen = new Set<number>();
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (
      !Number.isInteger(part.part_number) ||
      part.part_number < 1 ||
      part.part_number > count ||
      seen.has(part.part_number) ||
      (complete && part.part_number !== i + 1)
    )
      assetError(422, 'INVALID_UPLOAD_PARTS');
    if (
      typeof part.checksum_sha256 !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(part.checksum_sha256) ||
      Buffer.from(part.checksum_sha256, 'base64').toString('base64') !==
        part.checksum_sha256
    )
      assetError(422, 'INVALID_PART_CHECKSUM');
    seen.add(part.part_number);
  }
}
export function expectedPartSize(part: number, total: number): number {
  return Math.min(
    ARTWORK_UPLOAD_POLICY.part_size_bytes,
    total - (part - 1) * ARTWORK_UPLOAD_POLICY.part_size_bytes
  );
}
