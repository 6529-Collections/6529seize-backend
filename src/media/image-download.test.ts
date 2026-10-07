const getMock = jest.fn();
const warnMock = jest.fn();
const infoMock = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: getMock,
    isAxiosError: (error: { isAxiosError?: boolean }) =>
      error?.isAxiosError === true
  }
}));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ warn: warnMock, info: infoMock }) }
}));

import sharp from 'sharp';
import { getArweaveFallbackUrls } from '@/arweave-gateway-fallback';
import {
  downloadImageBuffer,
  ImageSourceUnavailableError
} from './image-download';

const url = `https://arweave.net/${'A'.repeat(43)}?token=private-token`;
let png: Buffer;

beforeAll(async () => {
  png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#ff0000' }
  })
    .png()
    .toBuffer();
});

beforeEach(() => jest.clearAllMocks());

it.each([Buffer.alloc(0), Buffer.from('<html>Gateway unavailable</html>')])(
  'advances to another gateway when HTTP 200 contains unusable image bytes',
  async (invalid) => {
    getMock.mockResolvedValueOnce({ status: 200, data: invalid });
    getMock.mockResolvedValueOnce({ status: 200, data: png });

    await expect(downloadImageBuffer(url)).resolves.toEqual(png);
    expect(getMock.mock.calls.map(([candidate]) => candidate)).toEqual([
      url,
      getArweaveFallbackUrls(url)[0]
    ]);
    expect(getMock).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        timeout: 15_000,
        'axios-retry': { retries: 0 }
      })
    );
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnMock.mock.calls)).not.toContain('private-token');
    expect(infoMock).toHaveBeenCalledWith(
      expect.stringContaining('IMAGE_DOWNLOAD_ACCEPTED')
    );
  }
);

it('decodes image data before accepting an original, including GIF', async () => {
  const gif = await sharp(png).gif().toBuffer();
  getMock.mockResolvedValue({ status: 200, data: gif });
  await expect(downloadImageBuffer(url)).resolves.toEqual(gif);
  expect(getMock).toHaveBeenCalledTimes(1);
});

it('rejects a truncated image even when its headers can be read', async () => {
  const truncated = png.subarray(0, png.length - 20);
  await expect(sharp(truncated).metadata()).resolves.toMatchObject({
    format: 'png'
  });
  getMock.mockResolvedValueOnce({ status: 200, data: truncated });
  getMock.mockResolvedValueOnce({ status: 200, data: png });
  await expect(downloadImageBuffer(url)).resolves.toEqual(png);
  expect(warnMock).toHaveBeenCalledWith(
    expect.stringContaining('reason=INVALID_IMAGE')
  );
});

it('falls back on network timeouts without leaking request configuration', async () => {
  getMock.mockRejectedValueOnce({
    isAxiosError: true,
    code: 'ECONNABORTED',
    config: { headers: { Authorization: 'secret' }, url }
  });
  getMock.mockResolvedValueOnce({ status: 200, data: png });
  await expect(downloadImageBuffer(url)).resolves.toEqual(png);
  expect(warnMock).toHaveBeenCalledWith(
    expect.stringContaining('reason=REQUEST_FAILED')
  );
  expect(JSON.stringify(warnMock.mock.calls)).not.toMatch(
    /private-token|Authorization|secret/
  );
});

it('fails the job when every gateway is empty and can recover on a later attempt', async () => {
  getMock.mockResolvedValue({ status: 200, data: Buffer.alloc(0) });
  const failure = await downloadImageBuffer(url).catch(
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(ImageSourceUnavailableError);
  expect(failure).toMatchObject({
    failure: { reason: 'EMPTY_BODY', bytes: 0 }
  });
  expect(getMock).toHaveBeenCalledTimes(
    new Set([url, ...getArweaveFallbackUrls(url)]).size
  );
  expect(String(failure)).not.toContain('private-token');

  getMock.mockResolvedValue({ status: 200, data: png });
  await expect(downloadImageBuffer(url)).resolves.toEqual(png);
});

it('reports a bounded timeout diagnostic when a non-Arweave source fails', async () => {
  getMock.mockRejectedValue({ isAxiosError: true, code: 'ETIMEDOUT' });
  await expect(
    downloadImageBuffer('https://example.test/image?token=secret')
  ).rejects.toMatchObject({
    attempts: 1,
    failure: { category: 'TIMEOUT', gateway: 'example.test' }
  });
});
