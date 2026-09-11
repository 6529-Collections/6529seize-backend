import { createServer, Server } from 'node:http';
import { Socket } from 'node:net';
import { AddressInfo } from 'node:net';
import { FetchRequest } from 'ethers';
import {
  createResolutionRpcTransport,
  getResolutionRpcProvider
} from '@/nft-links/lib/resolution-rpc';
import { fetchTextWithTimeout } from '@/nft-links/lib/http';
import {
  getNftLinkResolutionBudget,
  withNftLinkResolutionBudget
} from '@/nft-links/resolution-budget';

describe('NFT link network cancellation', () => {
  let server: Server;
  let url: string;
  const sockets = new Set<Socket>();

  beforeEach(async () => {
    server = createServer((request, response) => {
      if (request.url?.startsWith('/failure')) {
        request.socket.destroy();
        return;
      }
      if (['/http-error', '/redirect'].includes(request.url ?? '')) {
        response.writeHead(request.url === '/redirect' ? 302 : 500, {
          location: url + '/body'
        });
        response.write('unfinished error body');
        return;
      }
      if (request.url === '/body') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{');
      }
      // /headers never responds. /body never finishes its response body.
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it.each(['/headers', '/body'])(
    'aborts the RPC socket while waiting for %s',
    async (path) => {
      await withNftLinkResolutionBudget(2000, async () => {
        const request = new FetchRequest(url + path);
        request.timeout = 100;
        request.getUrlFunc = createResolutionRpcTransport(
          getNftLinkResolutionBudget()!
        );
        await expect(request.send()).rejects.toMatchObject({
          name: 'AbortError'
        });
      });
      // Let the remote peer observe cancellation; the teardown is only a fallback.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(sockets.size).toBe(0);
    }
  );

  it('uses the overall deadline to cancel an otherwise longer metadata fetch', async () => {
    await withNftLinkResolutionBudget(100, async () => {
      await expect(
        fetchTextWithTimeout(url + '/body', { timeoutMs: 5000 })
      ).rejects.toMatchObject({ name: 'AbortError' });
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sockets.size).toBe(0);
  });

  it.each([
    ['rpc', '/http-error'],
    ['metadata', '/http-error'],
    ['rpc', '/redirect']
  ])(
    'closes unread %s %s response bodies before the resolution ends',
    async (transport, path) => {
      await withNftLinkResolutionBudget(2000, async () => {
        if (transport === 'rpc') {
          const request = new FetchRequest(url + path);
          request.getUrlFunc = createResolutionRpcTransport(
            getNftLinkResolutionBudget()!
          );
          await expect(request.send()).rejects.toThrow(
            'NFT link RPC transport failed'
          );
        } else {
          await expect(
            fetchTextWithTimeout(url + path, { timeoutMs: 5000 })
          ).rejects.toThrow('HTTP 500');
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(sockets.size).toBe(0);
      });
    }
  );

  it('does not expose credential-bearing RPC URLs in transport errors', async () => {
    await withNftLinkResolutionBudget(2000, async () => {
      const request = new FetchRequest(
        url + '/failure?apiKey=private-test-key'
      );
      request.getUrlFunc = createResolutionRpcTransport(
        getNftLinkResolutionBudget()!
      );
      await expect(request.send()).rejects.toThrow(
        'NFT link RPC transport failed'
      );
    });
  });

  it('rejects queued RPC work and destroys the provider if network discovery stalls', async () => {
    const original = process.env.NFT_INDEXER_RPC;
    process.env.NFT_INDEXER_RPC = url + '/headers';
    const consoleSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    let provider: ReturnType<typeof getResolutionRpcProvider> | undefined;
    try {
      await withNftLinkResolutionBudget(100, async () => {
        const budget = getNftLinkResolutionBudget()!;
        provider = getResolutionRpcProvider(budget);
        expect(provider._getConnection().timeout).toBe(5000);
        await expect(provider.getBlockNumber()).rejects.toBeDefined();
      });
      expect(provider?.destroyed).toBe(true);
    } finally {
      if (original === undefined) delete process.env.NFT_INDEXER_RPC;
      else process.env.NFT_INDEXER_RPC = original;
      consoleSpy.mockRestore();
    }
  });
});
