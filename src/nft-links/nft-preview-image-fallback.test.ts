import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '@/env';
import { HttpError } from './lib/http';
import { SQS } from '@/sqs';
import { NftLinksDb } from './nft-links.db';
import { NftLinkMediaPreviewService } from './nft-link-media-preview.service';
import { NftPreviewOversizeError } from './nft-preview-size-policy';

const video = 'https://example.com/video.mp4';
const image = 'https://example.com/image.png';
const bytes = readFileSync(join(__dirname, '../../scripts/media-fixtures/png'));
const oversize = () =>
  new NftPreviewOversizeError(250000000, 268718680, 'content-length');
const makeService = () =>
  new NftLinkMediaPreviewService({} as NftLinksDb, {} as SQS);
afterEach(() => jest.restoreAllMocks());

it('stores the image fallback as READY image under the original source fence without modifying metadata', async () => {
  const sourceHash = createHash('sha256').update(video).digest('hex');
  const entity = {
    canonical_id: 'synthetic',
    media_uri: video,
    media_preview_source_hash: sourceHash,
    media_preview_error_message: 'lease',
    full_data: {
      asset: {
        media: { kind: 'animation', animationUrl: video, imageUrl: image }
      }
    }
  };
  const original = JSON.stringify(entity);
  const db = {
    lockMediaPreviewForProcessing: jest.fn().mockResolvedValue(entity),
    updateMediaPreviewWithSuccess: jest.fn().mockResolvedValue(true),
    updateMediaPreviewWithFailure: jest.fn()
  };
  const service = new NftLinkMediaPreviewService(
    db as unknown as NftLinksDb,
    {} as SQS
  );
  const download = jest
    .spyOn(service as never, 'downloadWithinDeadline')
    .mockRejectedValueOnce(oversize() as never)
    .mockResolvedValueOnce({
      bytes,
      finalUrl: image,
      contentType: 'image/png'
    } as never);
  jest.spyOn(service as never, 'uploadPreviewVariants').mockResolvedValue({
    cardUrl: 'card',
    thumbUrl: 'thumb',
    smallUrl: 'small'
  } as never);
  const log = jest
    .spyOn(service['logger'], 'error')
    .mockImplementation(() => undefined);
  await service.processQueueMessage(
    JSON.stringify({ canonicalId: 'synthetic', sourceHash }),
    {}
  );
  expect(download).toHaveBeenNthCalledWith(
    2,
    image,
    expect.any(AbortSignal),
    true
  );
  expect(db.updateMediaPreviewWithSuccess).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'image',
      sourceHash,
      mimeType: 'image/webp',
      cardUrl: 'card',
      fence: { sourceHash, lease: 'lease' }
    }),
    {}
  );
  expect(db.updateMediaPreviewWithFailure).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(JSON.stringify(entity)).toBe(original);
});

it.each([undefined, video])(
  'preserves the oversize failure without a distinct image (%s)',
  async (fallback) => {
    const service = makeService();
    const error = oversize();
    const download = jest
      .spyOn(service as never, 'downloadWithinDeadline')
      .mockRejectedValue(error as never);
    await expect(service['downloadRemoteImage'](video, fallback)).rejects.toBe(
      error
    );
    expect(download).toHaveBeenCalledTimes(1);
  }
);

it.each([403, 429, 500, 503])(
  'does not fall back for HTTP %s',
  async (status) => {
    const service = makeService();
    const error = new HttpError(status, video, `HTTP ${status}`);
    const download = jest
      .spyOn(service as never, 'downloadWithinDeadline')
      .mockRejectedValue(error as never);
    await expect(service['downloadRemoteImage'](video, image)).rejects.toBe(
      error
    );
    expect(download).toHaveBeenCalledTimes(1);
  }
);

it('rejects an HTML fallback instead of marking the preview ready', async () => {
  const service = makeService();
  jest
    .spyOn(service as never, 'downloadWithinDeadline')
    .mockRejectedValueOnce(oversize() as never)
    .mockResolvedValueOnce({
      bytes: Buffer.from('<html>not an image</html>'),
      finalUrl: image,
      contentType: 'text/html'
    } as never);
  await expect(service['downloadRemoteImage'](video, image)).rejects.toThrow(
    'fallback is not an image'
  );
});

it('retains private-address protection for the fallback', async () => {
  const service = makeService();
  jest
    .spyOn(service as never, 'downloadWithinDeadline')
    .mockRejectedValueOnce(oversize() as never);
  await expect(
    service['downloadRemoteImage'](video, 'http://127.0.0.1/image')
  ).rejects.toThrow('private/local');
});

it('shares one deadline across the original download and the fallback', async () => {
  const service = makeService();
  jest
    .spyOn(env, 'getIntOrNull')
    .mockImplementation((key) =>
      key === 'NFT_LINK_MEDIA_PREVIEW_DOWNLOAD_TIMEOUT_MS' ? 40 : null
    );
  const download = jest
    .spyOn(service as never, 'downloadWithinDeadline')
    .mockImplementationOnce(
      (() =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(oversize()), 20)
        )) as never
    )
    .mockImplementationOnce(
      ((_url: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true }
          );
        })) as never
    );
  await expect(service['downloadRemoteImage'](video, image)).rejects.toThrow(
    'download deadline exceeded'
  );
  expect(download).toHaveBeenCalledTimes(2);
  expect(download.mock.calls[0][1]).toBe(download.mock.calls[1][1]);
  expect((download.mock.calls[1][1] as AbortSignal).aborted).toBe(true);
});

it.each([404, 410])(
  'uses the metadata image after HTTP %s from the animation',
  async (status) => {
    const service = makeService();
    jest
      .spyOn(service as never, 'downloadWithinDeadline')
      .mockRejectedValueOnce(
        new HttpError(status, video, `HTTP ${status}`) as never
      )
      .mockResolvedValueOnce({
        bytes,
        finalUrl: image,
        contentType: 'image/png'
      } as never);
    await expect(
      service['downloadRemoteImage'](video, image)
    ).resolves.toMatchObject({ bytes, finalUrl: image });
  }
);

it('uses the metadata image after unsupported HTML without changing the animation URL', async () => {
  const service = makeService();
  jest
    .spyOn(service as never, 'downloadWithinDeadline')
    .mockResolvedValueOnce({
      bytes: Buffer.from('<html>interactive artwork</html>'),
      finalUrl: video,
      contentType: 'text/html'
    } as never)
    .mockResolvedValueOnce({
      bytes,
      finalUrl: image,
      contentType: 'image/png'
    } as never);
  await expect(
    service['downloadRemoteImage'](video, image)
  ).resolves.toMatchObject({ bytes, finalUrl: image });
});

it('retains a failed fallback as a failure', async () => {
  const service = makeService();
  const failure = new HttpError(404, image, 'Image HTTP 404');
  jest
    .spyOn(service as never, 'downloadWithinDeadline')
    .mockRejectedValueOnce(oversize() as never)
    .mockRejectedValueOnce(failure as never);
  await expect(service['downloadRemoteImage'](video, image)).rejects.toBe(
    failure
  );
});

it('preserves unsupported HTML when no fallback image exists', async () => {
  const service = makeService();
  const html = {
    bytes: Buffer.from('<html>artwork</html>'),
    finalUrl: video,
    contentType: 'text/html'
  };
  jest
    .spyOn(service as never, 'downloadWithinDeadline')
    .mockResolvedValueOnce(html as never);
  await expect(service['downloadRemoteImage'](video)).resolves.toBe(html);
});
