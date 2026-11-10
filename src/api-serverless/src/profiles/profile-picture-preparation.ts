import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import {
  LosslessStripFormat,
  stripMetadataLosslessly
} from '@/media/metadata-strip/lossless-metadata-strip';

const logger = Logger.get('PROFILE_PICTURE_IPFS_UPLOAD');

/** Matches the limit the profile editor enforces before upload. */
export const PROFILE_PICTURE_MAX_BYTES = 2 * 1024 * 1024;

interface ProfilePictureFormat {
  readonly contentType: string;
  readonly extension: string;
  readonly container: LosslessStripFormat;
  readonly matches: (bytes: Buffer) => boolean;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

function hasAsciiAt(bytes: Buffer, value: string, offset = 0): boolean {
  return (
    bytes.length >= offset + value.length &&
    bytes.toString('latin1', offset, offset + value.length) === value
  );
}

// Formats are recognised from the file's own bytes; the client's file name
// and declared type are ignored.
const PROFILE_PICTURE_FORMATS: readonly ProfilePictureFormat[] = [
  {
    contentType: 'image/png',
    extension: 'png',
    container: 'png',
    matches: (bytes) => bytes.subarray(0, 8).equals(PNG_SIGNATURE)
  },
  {
    contentType: 'image/jpeg',
    extension: 'jpg',
    container: 'jpeg',
    matches: (bytes) =>
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
  },
  {
    contentType: 'image/gif',
    extension: 'gif',
    container: 'gif',
    matches: (bytes) =>
      hasAsciiAt(bytes, 'GIF87a') || hasAsciiAt(bytes, 'GIF89a')
  },
  {
    contentType: 'image/webp',
    extension: 'webp',
    container: 'webp',
    matches: (bytes) =>
      hasAsciiAt(bytes, 'RIFF') && hasAsciiAt(bytes, 'WEBP', 8)
  }
];

export function detectProfilePictureFormat(
  bytes: Buffer
): Pick<
  ProfilePictureFormat,
  'contentType' | 'extension' | 'container'
> | null {
  const format = PROFILE_PICTURE_FORMATS.find((candidate) =>
    candidate.matches(bytes)
  );
  return format
    ? {
        contentType: format.contentType,
        extension: format.extension,
        container: format.container
      }
    : null;
}

/**
 * Identifying metadata is always removed first (IPFS pins are permanent),
 * whatever the drop-media privacy flag says. The API bundle has no image
 * decoder, so there is no re-encoding fallback here: the strip is verified
 * structurally (same size and orientation, byte-identical image data and ICC
 * profile, none of the removed blocks left), and anything that cannot be
 * stripped that way is rejected rather than pinned.
 */
export function stripProfilePictureMetadata(
  bytes: Buffer,
  container: LosslessStripFormat
): Buffer {
  try {
    return stripMetadataLosslessly(bytes, container).output;
  } catch (error) {
    logger.warn(
      `Rejected a ${container} profile picture whose metadata could not be removed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    throw new BadRequestException(
      'This profile picture could not be cleaned of its metadata. Export it again as a standard PNG, JPEG, GIF or WebP image and retry.'
    );
  }
}

export interface PreparedProfilePicture {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly extension: string;
}

/**
 * Size check, format detection from the bytes and metadata removal shared by
 * every profile picture upload path.
 */
export function prepareProfilePictureUpload(
  file: Pick<Express.Multer.File, 'buffer'> | undefined
): PreparedProfilePicture {
  const bytes = file?.buffer;
  if (!bytes?.length) {
    throw new BadRequestException('No profile picture provided');
  }
  if (bytes.length > PROFILE_PICTURE_MAX_BYTES) {
    throw new CustomApiCompliantException(413, 'Profile picture is too large');
  }
  const format = detectProfilePictureFormat(bytes);
  if (!format) {
    throw new BadRequestException(
      'Profile picture must be a PNG, JPEG, GIF or WebP image'
    );
  }
  return {
    bytes: stripProfilePictureMetadata(bytes, format.container),
    contentType: format.contentType,
    extension: format.extension
  };
}
