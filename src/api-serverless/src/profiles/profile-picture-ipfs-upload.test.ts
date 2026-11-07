import fc from 'fast-check';
import {
  detectProfilePictureFormat,
  PROFILE_PICTURE_MAX_BYTES,
  ProfilePictureIpfsUploadService
} from './profile-picture-ipfs-upload';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from('WEBPVP8 ')
]);

function createService() {
  const uploader = {
    uploadFile: jest.fn().mockResolvedValue({
      cid: 'QmProfilePicture',
      url: 'ipfs://QmProfilePicture'
    })
  };
  return { uploader, service: new ProfilePictureIpfsUploadService(uploader) };
}

describe('detectProfilePictureFormat', () => {
  it.each([
    [PNG, 'image/png', 'png'],
    [JPEG, 'image/jpeg', 'jpg'],
    [GIF, 'image/gif', 'gif'],
    [Buffer.from('GIF87a', 'latin1'), 'image/gif', 'gif'],
    [WEBP, 'image/webp', 'webp']
  ])('recognises %#', (bytes, contentType, extension) => {
    expect(detectProfilePictureFormat(bytes)).toEqual({
      contentType,
      extension
    });
  });

  it.each([
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['svg with xml prolog', '<?xml version="1.0"?><svg></svg>'],
    ['html', '<!doctype html><html></html>'],
    ['riff without webp', 'RIFF\x24\x00\x00\x00WAVEfmt '],
    ['truncated png', '\x89PNG'],
    ['empty', '']
  ])('rejects %s', (_, text) => {
    expect(detectProfilePictureFormat(Buffer.from(text, 'latin1'))).toBeNull();
  });

  it('only accepts bytes that start with a supported signature', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (array) => {
        const bytes = Buffer.from(array);
        const format = detectProfilePictureFormat(bytes);
        const startsWithSignature =
          bytes.subarray(0, 8).equals(PNG.subarray(0, 8)) ||
          bytes.subarray(0, 3).equals(JPEG.subarray(0, 3)) ||
          ['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6)) ||
          (bytes.toString('latin1', 0, 4) === 'RIFF' &&
            bytes.toString('latin1', 8, 12) === 'WEBP');
        expect(format !== null).toBe(startsWithSignature);
      })
    );
  });
});

describe('ProfilePictureIpfsUploadService', () => {
  it('pins a recognised image and returns its ipfs url', async () => {
    const { service, uploader } = createService();

    await expect(service.upload({ buffer: WEBP })).resolves.toEqual({
      pfp_url: 'ipfs://QmProfilePicture'
    });
    expect(uploader.uploadFile).toHaveBeenCalledWith({
      fileName: 'pfp.webp',
      fileBuffer: WEBP,
      contentType: 'image/webp'
    });
  });

  it('rejects a missing or empty file', async () => {
    const { service, uploader } = createService();

    await expect(service.upload(undefined)).rejects.toThrow(
      'No profile picture provided'
    );
    await expect(service.upload({ buffer: Buffer.alloc(0) })).rejects.toThrow(
      'No profile picture provided'
    );
    expect(uploader.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects files that are not raster images', async () => {
    const { service, uploader } = createService();

    await expect(
      service.upload({ buffer: Buffer.from('<svg></svg>') })
    ).rejects.toThrow('Profile picture must be a PNG, JPEG, GIF or WebP image');
    expect(uploader.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects files over the size limit', async () => {
    const { service, uploader } = createService();
    const oversized = Buffer.concat([
      PNG,
      Buffer.alloc(PROFILE_PICTURE_MAX_BYTES)
    ]);

    await expect(service.upload({ buffer: oversized })).rejects.toMatchObject({
      message: 'Profile picture is too large',
      getStatusCode: expect.any(Function)
    });
    await expect(
      service
        .upload({ buffer: oversized })
        .catch((error) => error.getStatusCode())
    ).resolves.toBe(413);
    expect(uploader.uploadFile).not.toHaveBeenCalled();
  });
});
