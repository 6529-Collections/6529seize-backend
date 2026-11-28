import sharp from 'sharp';
import { getArweaveFallbackUrls } from '@/arweave-gateway-fallback';
import { publicFetch } from '@/http/public-fetch';
import { fetchRememeMedia } from './rememe-media-download';

jest.mock('@/http/public-fetch', () => ({ publicFetch: jest.fn() }));
jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })
  }
}));

const url = `https://arweave.net/${'A'.repeat(43)}`;
const mp4 = Buffer.from(
  '000000186674797069736f6d0000000069736f6d6d703432',
  'hex'
);
let image: Buffer;

beforeAll(async () => {
  image = await sharp({
    create: { width: 8, height: 8, channels: 3, background: 'red' }
  })
    .png()
    .toBuffer();
});
beforeEach(() => jest.mocked(publicFetch).mockReset());

function response(
  body: Buffer,
  status = 200
): Awaited<ReturnType<typeof publicFetch>> {
  return {
    status,
    ok: status === 200,
    body,
    finalUrl: url,
    headers: new (require('node-fetch').Headers)()
  };
}

it.each([
  ['HTML', Buffer.from('<html>temporary gateway error</html>')],
  ['empty bytes', Buffer.alloc(0)],
  [
    'truncated raster',
    Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000008000000080802000000',
      'hex'
    )
  ]
])(
  'advances gateways when HTTP 200 contains %s instead of an image',
  async (_name, invalid) => {
    jest
      .mocked(publicFetch)
      .mockResolvedValueOnce(response(invalid))
      .mockResolvedValueOnce(response(image));
    await expect(fetchRememeMedia(url, 'png')).resolves.toEqual(image);
    expect(publicFetch).toHaveBeenCalledTimes(2);
    const hosts = jest
      .mocked(publicFetch)
      .mock.calls.map(([candidate]) => new URL(candidate).host);
    expect(new Set(hosts).size).toBe(2);
  }
);

it('rejects a JPEG with a valid header but truncated pixel data before accepting the gateway', async () => {
  const jpeg = await sharp({
    create: { width: 64, height: 64, channels: 3, background: 'blue' }
  })
    .jpeg()
    .toBuffer();
  const invalid = jpeg.subarray(0, jpeg.length - 20);
  await expect(sharp(invalid).metadata()).resolves.toMatchObject({
    format: 'jpeg',
    width: 64
  });
  jest
    .mocked(publicFetch)
    .mockResolvedValueOnce(response(invalid))
    .mockResolvedValueOnce(response(image));
  await expect(fetchRememeMedia(url, 'jpg')).resolves.toEqual(image);
  expect(publicFetch).toHaveBeenCalledTimes(2);
});

it('uses supported video container validation inside the gateway attempt', async () => {
  jest
    .mocked(publicFetch)
    .mockResolvedValueOnce(response(Buffer.from('<html>error</html>')))
    .mockResolvedValueOnce(response(mp4));
  await expect(fetchRememeMedia(url, 'mp4')).resolves.toEqual(mp4);
  expect(publicFetch).toHaveBeenCalledTimes(2);
});

it('rejects after all image gateways return bad bytes', async () => {
  jest
    .mocked(publicFetch)
    .mockImplementation(async () =>
      response(Buffer.from('<html>error</html>'))
    );
  await expect(fetchRememeMedia(url, 'png')).rejects.toThrow(
    'not a supported image'
  );
  expect(publicFetch).toHaveBeenCalledTimes(
    new Set([url, ...getArweaveFallbackUrls(url)]).size
  );
});

it('rejects after all video gateways return bad bytes', async () => {
  jest
    .mocked(publicFetch)
    .mockImplementation(async () =>
      response(Buffer.from('<html>error</html>'))
    );
  await expect(fetchRememeMedia(url, 'mp4')).rejects.toThrow(
    'not a supported video'
  );
});

it('preserves the public transport byte cap, redirects and attempt signal', async () => {
  jest.mocked(publicFetch).mockResolvedValueOnce(response(image));
  await fetchRememeMedia(url, 'png');
  expect(publicFetch).toHaveBeenCalledWith(
    url,
    expect.objectContaining({
      method: 'GET',
      maxBytes: 100 * 1024 * 1024,
      maxRedirects: 5,
      requestTimeoutMs: 30000,
      timeoutMs: 300000,
      signal: expect.any(AbortSignal)
    })
  );
});
