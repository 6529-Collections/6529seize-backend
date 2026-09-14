import { CustomApiCompliantException } from '@/exceptions';
import type { ContextRecord } from '@/artwork-documentation/artwork-documentation.types';
import { MAX_PDF_BYTES } from '@/attachments/pdf-content-validator';
import {
  ARTWORK_ASSET_ROLES,
  AssetAccess,
  ArtworkAssetListRow,
  AssetClass,
  AssetPart,
  StartArtworkUpload
} from '@/artwork-documentation/assets/artwork-assets.types';

export const ARTWORK_UPLOAD_POLICY = Object.freeze({
  max_asset_bytes: 8 * 1024 ** 3,
  context_quota_bytes: 128 * 1024 ** 3,
  max_assets: 1000,
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

export const PASSIVE_MEDIA_MIMES = new Set([
  'audio/wav',
  'audio/flac',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/aiff',
  'video/mp4',
  'video/quicktime',
  'video/webm'
]);
const IMAGE_MIMES: Record<string, string[]> = {
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  png: ['image/png'],
  tif: ['image/tiff'],
  tiff: ['image/tiff'],
  webp: ['image/webp'],
  gif: ['image/gif']
};
const LEGACY_FORMATS: Readonly<Record<string, readonly string[]>> =
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

export const ARTWORK_FORMATS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    ...LEGACY_FORMATS,
    iiq: ['image/x-phaseone-iiq'],
    icc: ['application/vnd.iccprofile'],
    icm: ['application/vnd.iccprofile'],
    cos: ['application/xml', 'text/xml'],
    costyle: ['application/xml', 'text/xml'],
    cop: ['application/xml', 'text/xml'],
    cosessiondb: ['application/vnd.sqlite3'],
    zip: ['application/zip', 'application/x-zip-compressed'],
    html: ['text/html'],
    htm: ['text/html'],
    svg: ['image/svg+xml'],
    css: ['text/css'],
    js: ['text/javascript', 'application/javascript'],
    mjs: ['text/javascript', 'application/javascript'],
    ts: ['text/plain', 'text/typescript'],
    tsx: ['text/plain'],
    jsx: ['text/plain'],
    py: ['text/x-python', 'text/plain'],
    pde: ['text/plain'],
    glsl: ['text/plain'],
    vert: ['text/plain'],
    frag: ['text/plain'],
    sol: ['text/plain'],
    json: ['application/json'],
    xml: ['application/xml', 'text/xml'],
    yaml: ['application/yaml', 'text/yaml', 'text/plain'],
    yml: ['application/yaml', 'text/yaml', 'text/plain'],
    vtt: ['text/vtt'],
    srt: ['application/x-subrip', 'text/plain'],
    ttf: ['font/ttf'],
    otf: ['font/otf'],
    woff: ['font/woff'],
    woff2: ['font/woff2'],
    glb: ['model/gltf-binary'],
    gltf: ['model/gltf+json'],
    obj: ['model/obj', 'text/plain'],
    mtl: ['text/plain'],
    blend: ['application/x-blender'],
    wasm: ['application/wasm'],
    webm: ['video/webm', 'audio/webm'],
    ogg: ['audio/ogg', 'video/ogg', 'application/ogg'],
    opus: ['audio/ogg', 'audio/opus'],
    aif: ['audio/aiff', 'audio/x-aiff'],
    aiff: ['audio/aiff', 'audio/x-aiff'],
    avif: ['image/avif'],
    exr: ['image/x-exr'],
    epub: ['application/epub+zip']
  });

const PROFILE_FINAL_FORMATS: Readonly<Record<string, readonly string[]>> = {
  photography: ['avif', 'heic', 'heif', 'exr'],
  digital_art: ['svg', 'avif', 'exr', 'psd', 'psb'],
  video: ['mp4', 'mov', 'webm', 'ogg'],
  audio: ['wav', 'flac', 'mp3', 'm4a', 'ogg', 'opus', 'aif', 'aiff', 'webm'],
  html: ['html', 'htm', 'zip'],
  generative: ['html', 'htm', 'js', 'mjs', 'py', 'pde', 'zip', 'wasm'],
  interactive: ['html', 'htm', 'zip', 'wasm'],
  spatial: ['glb', 'gltf', 'obj', 'blend', 'zip'],
  text: ['txt', 'md', 'pdf', 'epub', 'html', 'htm'],
  installation: ['zip']
};

export function assetClass(
  role: string,
  access: Pick<AssetAccess, 'publicationOnlyV3'> = {}
): AssetClass {
  return !access.publicationOnlyV3 &&
    (role === 'consent_instrument' || role === 'rights_instrument')
    ? 'rights_evidence'
    : 'artwork';
}
const PUBLICATION_ASSET_ROLES = new Set<string>([
  'artwork_final',
  'preservation_master',
  'process_evidence',
  'display_derivative',
  'interview_recording',
  'interview_transcript',
  'other_supporting'
]);
type PublicationAssetAccess = Pick<
  AssetAccess,
  | 'publicationOnly'
  | 'publicationOnlyV3'
  | 'canPublishInterviewRecording'
  | 'canPublishInterviewTranscript'
  | 'mediaProfiles'
>;
export function publicationAssetAccess(
  context: Pick<ContextRecord, 'profile' | 'modules'>
): PublicationAssetAccess {
  const interview = context.modules.interview ?? {};
  const media = context.modules.artwork?.media_profiles;
  return {
    publicationOnlyV3:
      context.profile.version === 3 &&
      context.profile.intake_mode === 'publication_only',
    mediaProfiles:
      context.profile.version === 3 &&
      media?.status === 'provided' &&
      Array.isArray(media.value)
        ? media.value.filter(
            (value): value is string =>
              typeof value === 'string' && Boolean(PROFILE_FINAL_FORMATS[value])
          )
        : undefined,
    publicationOnly: context.profile.intake_mode === 'publication_only',
    canPublishInterviewRecording:
      interview.recording_permission?.status === 'provided' &&
      interview.recording_permission.value === 'intended_public_record',
    canPublishInterviewTranscript:
      interview.transcript_permission?.status === 'provided' &&
      interview.transcript_permission.value === 'intended_public_record'
  };
}
export function requirePublicationAsset(
  access: PublicationAssetAccess,
  input: { role: string; intended_visibility: string }
): void {
  if (!access.publicationOnly) return;
  const publicMaterial =
    (access.publicationOnlyV3 || access.mediaProfiles?.length) &&
    ARTWORK_ASSET_ROLES.includes(
      input.role as (typeof ARTWORK_ASSET_ROLES)[number]
    ) &&
    assetClass(input.role, access) !== 'rights_evidence';
  if (!PUBLICATION_ASSET_ROLES.has(input.role) && !publicMaterial)
    assetError(422, 'PUBLICATION_ASSET_ROLE_REQUIRED');
  if (input.intended_visibility !== 'public_record')
    assetError(422, 'PUBLICATION_VISIBILITY_REQUIRED');
  if (
    !access.publicationOnlyV3 &&
    ((input.role === 'interview_recording' &&
      !access.canPublishInterviewRecording) ||
      (input.role === 'interview_transcript' &&
        !access.canPublishInterviewTranscript))
  )
    assetError(422, 'INTERVIEW_PUBLICATION_PERMISSION_REQUIRED');
}
export function validatePublicationAssetLink(
  access: PublicationAssetAccess,
  input: {
    role: string;
    intended_visibility: string;
    intended_terms: { kind: string };
    manifest?: Record<string, unknown>;
  }
): void {
  if (!access.publicationOnly) return;
  requirePublicationAsset(access, input);
  if (input.intended_terms.kind === 'private_deposit')
    assetError(422, 'PUBLICATION_ASSET_TERMS_REQUIRED');
  if (input.manifest)
    requirePublicationAsset(access, {
      role: typeof input.manifest.role === 'string' ? input.manifest.role : '',
      intended_visibility:
        typeof input.manifest.intended_visibility === 'string'
          ? input.manifest.intended_visibility
          : ''
    });
}
export function validateStartUpload(
  input: StartArtworkUpload,
  access: Pick<AssetAccess, 'mediaProfiles' | 'publicationOnlyV3'> = {}
): string {
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
  const formats = (
    access.mediaProfiles?.length ? ARTWORK_FORMATS : LEGACY_FORMATS
  )[extension];
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
  if (extension === 'pdf' && input.size_bytes > MAX_PDF_BYTES)
    assetError(413, 'PDF_SIZE_LIMIT');
  if (
    ['artwork_final', 'display_derivative'].includes(input.role) &&
    !IMAGE_MIMES[extension] &&
    !access.mediaProfiles?.some((profile) =>
      PROFILE_FINAL_FORMATS[profile]?.includes(extension)
    )
  )
    assetError(422, 'INVALID_FORMAT_FOR_ROLE');
  if (
    assetClass(input.role, access) === 'rights_evidence' &&
    input.intended_visibility !== 'restricted'
  )
    assetError(422, 'RIGHTS_EVIDENCE_IS_RESTRICTED');
  return extension;
}
export function canReadAsset(
  asset: ArtworkAssetListRow,
  access: AssetAccess
): boolean {
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
  asset: ArtworkAssetListRow,
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
    assetClass(role, access) === 'rights_evidence' &&
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
