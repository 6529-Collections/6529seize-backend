import { createHash } from 'node:crypto';
import fc from 'fast-check';
import Sharp from 'sharp';
import {
  IDENTIFYING_STRINGS,
  identifyingGif,
  identifyingJpeg,
  identifyingPng,
  identifyingWebp
} from '@/media/metadata-strip/fixtures/identifying-image-fixtures';
import { stripMetadataLosslessly } from '@/media/metadata-strip/lossless-metadata-strip';
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
    [PNG, 'image/png', 'png', 'png'],
    [JPEG, 'image/jpeg', 'jpg', 'jpeg'],
    [GIF, 'image/gif', 'gif', 'gif'],
    [Buffer.from('GIF87a', 'latin1'), 'image/gif', 'gif', 'gif'],
    [WEBP, 'image/webp', 'webp', 'webp']
  ])('recognises %#', (bytes, contentType, extension, container) => {
    expect(detectProfilePictureFormat(bytes)).toEqual({
      contentType,
      extension,
      container
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
    const webp = await Sharp({
      create: { width: 4, height: 4, channels: 3, background: '#336699' }
    })
      .webp()
      .toBuffer();

    await expect(service.upload({ buffer: webp })).resolves.toEqual({
      pfp_url: 'ipfs://QmProfilePicture'
    });
    expect(uploader.uploadFile).toHaveBeenCalledWith({
      fileName: 'pfp.webp',
      fileBuffer: webp,
      contentType: 'image/webp'
    });
  });

  it.each([
    ['jpg', 'image/jpeg', async () => (await identifyingJpeg()).jpeg],
    ['png', 'image/png', identifyingPng],
    ['webp', 'image/webp', identifyingWebp],
    ['gif', 'image/gif', async () => identifyingGif()]
  ])(
    'strips identifying %s metadata before anything is pinned',
    async (extension, contentType, make) => {
      const original = process.env.DROP_MEDIA_SANITIZE_IMAGES;
      process.env.DROP_MEDIA_SANITIZE_IMAGES = 'false';
      try {
        const { service, uploader } = createService();
        const input = await make();

        await service.upload({ buffer: input });

        expect(uploader.uploadFile).toHaveBeenCalledTimes(1);
        const pinned = uploader.uploadFile.mock.calls[0][0];
        expect(pinned).toMatchObject({
          fileName: `pfp.${extension}`,
          contentType
        });
        const text = pinned.fileBuffer.toString('latin1');
        for (const value of IDENTIFYING_STRINGS) {
          expect(text).not.toContain(value);
        }
        const animated = extension === 'gif' || extension === 'webp';
        const decode = async (image: Buffer) => {
          const { data, info } = await Sharp(image, { animated })
            .rotate()
            .raw()
            .toBuffer({ resolveWithObject: true });
          return `${info.width}x${info.height}:${createHash('sha256')
            .update(data)
            .digest('hex')}`;
        };
        expect(await decode(pinned.fileBuffer)).toBe(await decode(input));
        const [before, after] = await Promise.all([
          Sharp(input).metadata(),
          Sharp(pinned.fileBuffer).metadata()
        ]);
        expect(after.icc).toEqual(before.icc);
        expect(after.orientation ?? 1).toBe(before.orientation ?? 1);
      } finally {
        if (original === undefined)
          delete process.env.DROP_MEDIA_SANITIZE_IMAGES;
        else process.env.DROP_MEDIA_SANITIZE_IMAGES = original;
      }
    }
  );

  it('pins exactly the verified lossless output', async () => {
    const { service, uploader } = createService();
    const { jpeg } = await identifyingJpeg();

    await service.upload({ buffer: jpeg });

    expect(uploader.uploadFile.mock.calls[0][0].fileBuffer).toEqual(
      stripMetadataLosslessly(jpeg, 'jpeg').output
    );
  });

  it('rejects, without pinning, an image whose metadata cannot be removed', async () => {
    const { service, uploader } = createService();
    const { jpeg } = await identifyingJpeg();

    await expect(
      service.upload({ buffer: jpeg.subarray(0, jpeg.length - 64) })
    ).rejects.toThrow('could not be cleaned of its metadata');
    await expect(service.upload({ buffer: JPEG })).rejects.toThrow(
      'could not be cleaned of its metadata'
    );
    expect(uploader.uploadFile).not.toHaveBeenCalled();
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
