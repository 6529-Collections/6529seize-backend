import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Response } from 'node-fetch';
import { NftLinkMediaPreviewService } from '@/nft-links/nft-link-media-preview.service';
import { NftLinksDb } from '@/nft-links/nft-links.db';
import { SQS } from '@/sqs';
import { env } from '@/env';
import * as transport from '@/http/public-fetch';
import { fetchJsonWithTimeout } from '@/nft-links/lib/http';
import { getArweaveFallbackUrls } from '@/arweave-gateway-fallback';

const id = 'A'.repeat(43);
const url = `https://media.6529.io/arweave/${id}`;
const png = readFileSync(join(__dirname, '../../scripts/media-fixtures/png'));
afterEach(() => jest.restoreAllMocks());

function fixture() {
  const service = new NftLinkMediaPreviewService({} as NftLinksDb, {} as SQS);
  jest
    .spyOn(service as never, 'resolveSafeRemoteUrl')
    .mockResolvedValue({} as never);
  return service;
}

it('downloads the same NFT image from an alternate gateway after primary HTTP 404', async () => {
  const service = fixture();
  const failed = new Response('missing', { status: 404 });
  const cancel = jest.fn();
  const request = jest
    .spyOn(service as never, 'fetchWithTimeout')
    .mockResolvedValueOnce({ response: failed, cancel } as never)
    .mockResolvedValueOnce({
      response: new Response(Readable.from([png]), {
        headers: { 'content-type': 'image/png' }
      }),
      cancel: jest.fn()
    } as never);
  await expect(service['downloadRemoteImage'](url)).resolves.toMatchObject({
    bytes: png,
    finalUrl: `https://ardrive.net/${id}`
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('abandons an idle body, closes its stream, and downloads a usable preview from another gateway', async () => {
  const service = fixture();
  jest
    .spyOn(env, 'getIntOrNull')
    .mockImplementation((key) =>
      key === 'NFT_LINK_MEDIA_PREVIEW_BODY_IDLE_TIMEOUT_MS' ? 15 : null
    );
  const body = new PassThrough();
  const cancel = jest.fn(() => body.destroy());
  jest
    .spyOn(service as never, 'fetchWithTimeout')
    .mockResolvedValueOnce({ response: new Response(body), cancel } as never)
    .mockResolvedValueOnce({
      response: new Response(Readable.from([png])),
      cancel: jest.fn()
    } as never);
  await expect(service['downloadRemoteImage'](url)).resolves.toMatchObject({
    bytes: png,
    finalUrl: `https://ardrive.net/${id}`
  });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.destroyed).toBe(true);
});

it('validates metadata JSON inside each attempt instead of accepting a broken successful response', async () => {
  const open = jest
    .spyOn(transport, 'openPublicResponse')
    .mockResolvedValueOnce({
      response: new Response('<html>gateway error</html>'),
      finalUrl: url,
      cancel: jest.fn()
    })
    .mockResolvedValueOnce({
      response: new Response('{"name":"Durga","image":"ar://image"}'),
      finalUrl: `https://ardrive.net/${id}`,
      cancel: jest.fn()
    });
  await expect(
    fetchJsonWithTimeout(url, { timeoutMs: 500 })
  ).resolves.toMatchObject({ name: 'Durga' });
  expect(open).toHaveBeenCalledTimes(2);
});

it('preserves a real HTTP failure after exhausting preview gateways', async () => {
  const service = fixture();
  const request = jest
    .spyOn(service as never, 'fetchWithTimeout')
    .mockImplementation((async () => ({
      response: new Response('unavailable', { status: 503 }),
      cancel: jest.fn()
    })) as never);
  await expect(service['downloadRemoteImage'](url)).rejects.toThrow('HTTP 503');
  expect(request).toHaveBeenCalledTimes(
    new Set([url, ...getArweaveFallbackUrls(url)]).size
  );
});
