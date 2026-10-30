import { FetchRequest } from 'ethers';
import { createServer, RequestListener, Server } from 'node:http';
import type { Socket } from 'node:net';
import { abortableEnsGetUrl, publicEnsGetUrl } from './ens-refresh-transport';
import * as publicNetwork from './ens-refresh-public-network';
import { gzipSync } from 'node:zlib';

const servers: Server[] = [];
const sockets = new Set<Socket>();

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test server');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  jest.restoreAllMocks();
  sockets.forEach((socket) => socket.destroy());
  sockets.clear();
  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
  servers.length = 0;
});

it.each([301, 302])(
  'preserves ethers POST/body behavior on HTTP %s while stripping cross-host credentials',
  async (status) => {
    const observed: Array<{
      method?: string;
      body: string;
      authorization?: string;
      cookie?: string;
    }> = [];
    const target = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        observed.push({
          method: request.method,
          body: Buffer.concat(chunks).toString(),
          authorization: request.headers.authorization,
          cookie: request.headers.cookie
        });
        response.end('{"data":"0xbeef"}');
      });
    });
    const source = await listen((_request, response) => {
      response.writeHead(status, { location: target });
      response.end();
    });
    const input = new FetchRequest(source);
    input.body = { sender: '0xabc', data: '0x1234' };
    input.setHeader('authorization', 'Bearer synthetic-test-token');
    input.setHeader('cookie', 'synthetic-test-cookie');
    input.timeout = 1000;
    input.getUrlFunc = abortableEnsGetUrl;
    // Guard the installed ethers contract explicitly; its redirect preserves POST.
    const upstreamRedirect = input.redirect(target);
    expect(upstreamRedirect.method).toBe('POST');
    expect(upstreamRedirect.body).toEqual(input.body);
    expect((await input.send()).bodyJson).toEqual({ data: '0xbeef' });
    expect(observed).toEqual([
      {
        method: 'POST',
        body: Buffer.from(input.body!).toString(),
        authorization: undefined,
        cookie: undefined
      }
    ]);
  }
);

it('rejects a redirect to a non-HTTP protocol', async () => {
  const source = await listen((_request, response) => {
    response.writeHead(302, { location: 'file:///synthetic-test' });
    response.end();
  });
  const request = new FetchRequest(source);
  request.getUrlFunc = abortableEnsGetUrl;
  request.timeout = 1000;
  await expect(request.send()).rejects.toThrow('Unsupported ENS HTTP redirect');
});

it('supports relative gateway redirects within the same deadline', async () => {
  const source = await listen((request, response) => {
    if (request.url === '/') {
      response.writeHead(302, { location: '/result' });
      response.end();
    } else response.end('{"data":"0xbeef"}');
  });
  const request = new FetchRequest(source);
  request.getUrlFunc = abortableEnsGetUrl;
  request.timeout = 1000;
  expect((await request.send()).bodyJson).toEqual({ data: '0xbeef' });
});

it('blocks a private initial CCIP target', async () => {
  const request = new FetchRequest('http://169.254.169.254/latest/meta-data');
  request.getUrlFunc = publicEnsGetUrl;
  await expect(request.send()).rejects.toThrow();
});

it('rechecks public policy before following a CCIP redirect', async () => {
  const source = await listen((_request, response) => {
    response.writeHead(302, {
      location: 'http://169.254.169.254/latest/meta-data'
    });
    response.end();
  });
  // Allow only the local fixture's initial request, then use the real policy.
  jest
    .spyOn(publicNetwork, 'assertPublicEnsUrl')
    .mockImplementationOnce(() => undefined);
  const request = new FetchRequest(source);
  request.getUrlFunc = publicEnsGetUrl;
  request.timeout = 1000;
  await expect(request.send()).rejects.toThrow();
  expect(publicNetwork.assertPublicEnsUrl).toHaveBeenNthCalledWith(
    2,
    'http://169.254.169.254/latest/meta-data'
  );
});

it.each([false, true])(
  'bounds the response body before or after gzip decoding (gzip=%s)',
  async (gzip) => {
    const body = Buffer.alloc(1024 * 1024 + 1, 'a');
    const source = await listen((_request, response) => {
      if (gzip) response.setHeader('content-encoding', 'gzip');
      response.end(gzip ? gzipSync(body) : body);
    });
    const request = new FetchRequest(source);
    request.getUrlFunc = abortableEnsGetUrl;
    request.timeout = 1000;
    await expect(request.send()).rejects.toThrow();
  }
);
