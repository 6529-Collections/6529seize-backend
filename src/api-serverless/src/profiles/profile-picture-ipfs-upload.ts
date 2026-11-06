import {
  IpfsFileUploader,
  ipfsFileUploader
} from '@/attachments/ipfs-file-uploader';
import { BadRequestException } from '@/exceptions';

/** Matches the limit the profile editor enforces before upload. */
export const PROFILE_PICTURE_MAX_BYTES = 2 * 1024 * 1024;

interface ProfilePictureFormat {
  readonly contentType: string;
  readonly extension: string;
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
    matches: (bytes) => bytes.subarray(0, 8).equals(PNG_SIGNATURE)
  },
  {
    contentType: 'image/jpeg',
    extension: 'jpg',
    matches: (bytes) =>
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
  },
  {
    contentType: 'image/gif',
    extension: 'gif',
    matches: (bytes) =>
      hasAsciiAt(bytes, 'GIF87a') || hasAsciiAt(bytes, 'GIF89a')
  },
  {
    contentType: 'image/webp',
    extension: 'webp',
    matches: (bytes) =>
      hasAsciiAt(bytes, 'RIFF') && hasAsciiAt(bytes, 'WEBP', 8)
  }
];

export function detectProfilePictureFormat(
  bytes: Buffer
): Pick<ProfilePictureFormat, 'contentType' | 'extension'> | null {
  const format = PROFILE_PICTURE_FORMATS.find((candidate) =>
    candidate.matches(bytes)
  );
  return format
    ? { contentType: format.contentType, extension: format.extension }
    : null;
}

export class ProfilePictureIpfsUploadService {
  constructor(
    private readonly uploader: Pick<IpfsFileUploader, 'uploadFile'>
  ) {}

  public async upload(
    file: Pick<Express.Multer.File, 'buffer'> | undefined
  ): Promise<{ pfp_url: string }> {
    const bytes = file?.buffer;
    if (!bytes?.length) {
      throw new BadRequestException('No profile picture provided');
    }
    if (bytes.length > PROFILE_PICTURE_MAX_BYTES) {
      throw new BadRequestException('Profile picture is too large');
    }
    const format = detectProfilePictureFormat(bytes);
    if (!format) {
      throw new BadRequestException(
        'Profile picture must be a PNG, JPEG, GIF or WebP image'
      );
    }
    const { url } = await this.uploader.uploadFile({
      fileName: `pfp.${format.extension}`,
      fileBuffer: bytes,
      contentType: format.contentType
    });
    return { pfp_url: url };
  }
}

export const profilePictureIpfsUploadService =
  new ProfilePictureIpfsUploadService(ipfsFileUploader);
