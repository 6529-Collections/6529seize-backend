import * as http from 'node:http';
import { once } from 'node:events';
import { nftLinkMediaPreviewService as service } from './nft-link-media-preview.service';
import { NftPreviewOversizeError } from './nft-preview-size-policy';
import { env } from '@/env';
import { Readable } from 'node:stream';
import { Response } from 'node-fetch';

const servers: http.Server[] = [];
afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected owned TCP fixture');
  // Only this test seam permits the owned loopback fixture. Runtime SSRF policy is unchanged.
  jest.spyOn(service as never, 'resolveSafeRemoteUrl').mockResolvedValue({
    hostname: '127.0.0.1',
    address: '127.0.0.1',
    family: 4
  } as never);
  jest
    .spyOn(env, 'getIntOrNull')
    .mockImplementation((key) =>
      key === 'NFT_LINK_MEDIA_PREVIEW_MAX_BYTES'
        ? 8
        : key === 'NFT_LINK_MEDIA_PREVIEW_HTTP_TIMEOUT_MS'
          ? 1000
          : null
    );
  return `http://127.0.0.1:${address.port}/synthetic`;
}

it.each(['header', 'stream'] as const)(
  'aborts the actual request after %s oversize without allocating a large body',
  async (mode) => {
    let closed!: () => void;
    const remoteClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const url = await serve((_req, res) => {
      res.on('close', closed);
      res.writeHead(
        200,
        mode === 'header' ? { 'content-length': '271744590' } : {}
      );
      res.write(mode === 'header' ? 'x' : '123456789');
      // Deliberately do not end: acceptance requires the client's real cancellation.
    });
    const error: unknown = await service['downloadRemoteImage'](url).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(NftPreviewOversizeError);
    expect(error).toMatchObject({
      limitBytes: 8,
      mode: mode === 'header' ? 'content-length' : 'stream'
    });
    await remoteClosed;
  }
);

it('accepts exactly the byte limit and preserves header-only timeout semantics', async () => {
  const url = await serve((_req, res) => {
    res.writeHead(200, { 'content-length': '8', 'content-type': 'image/png' });
    res.flushHeaders();
    setTimeout(() => res.end('12345678'), 1200);
  });
  await expect(service['downloadRemoteImage'](url)).resolves.toMatchObject({
    bytes: Buffer.from('12345678'),
    contentType: 'image/png'
  });
});

it('preserves HTTP errors and cancels their unconsumed response', async () => {
  let closed!: () => void;
  const remoteClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const url = await serve((_req, res) => {
    res.on('close', closed);
    res.writeHead(429);
    res.write('x');
  });
  await expect(service['downloadRemoteImage'](url)).rejects.toThrow('HTTP 429');
  await remoteClosed;
});

it('still rejects unsafe destinations through the real guard', async () => {
  await expect(
    service['resolveSafeRemoteUrl']('http://127.0.0.1/')
  ).rejects.toThrow();
});

it('bounds the actual stream when Content-Length is malformed', async () => {
  const response = new Response(Readable.from([Buffer.from('123456789')]), {
    headers: { 'content-length': 'unknown' }
  });
  const cancel = jest.fn(() => (response.body as Readable).destroy());
  jest
    .spyOn(env, 'getIntOrNull')
    .mockImplementation((key) =>
      key === 'NFT_LINK_MEDIA_PREVIEW_MAX_BYTES' ? 8 : null
    );
  jest
    .spyOn(service as never, 'resolveSafeRemoteUrl')
    .mockResolvedValue({} as never);
  jest
    .spyOn(service as never, 'fetchWithTimeout')
    .mockResolvedValue({ response, cancel } as never);
  await expect(
    service['downloadRemoteImage']('https://example.com/synthetic')
  ).rejects.toMatchObject({ name: 'NftPreviewOversizeError', mode: 'stream' });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('cancels the redirect response without cancelling the independently guarded next request', async () => {
  let closed!: () => void;
  const redirectedClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const url = await serve((req, res) => {
    if (req.url === '/final') {
      res.end('ok');
      return;
    }
    res.on('close', closed);
    res.writeHead(302, { location: '/final' });
    res.write('x');
  });
  await expect(service['downloadRemoteImage'](url)).resolves.toMatchObject({
    bytes: Buffer.from('ok'),
    finalUrl: url.replace('/synthetic', '/final')
  });
  await redirectedClosed;
  expect(service['resolveSafeRemoteUrl']).toHaveBeenCalledTimes(2);
});
