import { createServer, Server } from 'node:http';
import { Socket } from 'node:net';
import { FetchRequest, FetchResponse } from 'ethers';
import {
  createEnsRefreshProvider,
  findEnsForRefresh
} from './ens-refresh-lookup';
import { lookupPrimaryEnsNameResult } from '@/ens-lookup';

jest.mock('@/ens-lookup', () => ({ lookupPrimaryEnsNameResult: jest.fn() }));
// Socket fixtures use loopback. The production public-address policy has its
// own tests, including private literals and the DNS answers used by connect.
jest.mock('@/refreshEnsLoop/ens-refresh-public-network', () => ({
  assertPublicEnsUrl: jest.fn(),
  publicEnsLookup: undefined
}));
const originalUrl = process.env.ETHEREUM_RPC_URL;
let server: Server | undefined;
const sockets = new Set<Socket>();

beforeEach(() => {
  process.env.ETHEREUM_RPC_URL = 'https://rpc.example.test';
  jest.resetAllMocks();
});
afterEach(async () => {
  jest.restoreAllMocks();
  sockets.forEach((socket) => socket.destroy());
  sockets.clear();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  if (originalUrl === undefined) delete process.env.ETHEREUM_RPC_URL;
  else process.env.ETHEREUM_RPC_URL = originalUrl;
});

it('bounds an indefinitely stalled lookup and destroys its isolated provider', async () => {
  jest
    .mocked(lookupPrimaryEnsNameResult)
    .mockImplementation(() => new Promise(() => undefined));
  await expect(findEnsForRefresh('0xaddress', 20)).resolves.toEqual({
    status: 'unavailable'
  });
  const provider = jest.mocked(lookupPrimaryEnsNameResult).mock.calls[0][1];
  expect(provider.destroyed).toBe(true);
});

it('returns a successful lookup and disposes the provider immediately', async () => {
  jest
    .mocked(lookupPrimaryEnsNameResult)
    .mockResolvedValue({ status: 'resolved', name: 'healthy.eth' });
  await expect(findEnsForRefresh('0xaddress', 10_000)).resolves.toEqual({
    status: 'resolved',
    name: 'healthy.eth'
  });
  expect(
    jest.mocked(lookupPrimaryEnsNameResult).mock.calls[0][1].destroyed
  ).toBe(true);
});

it('handles a lookup that rejects after its deadline without an unhandled rejection', async () => {
  let rejectLookup!: (error: Error) => void;
  jest.mocked(lookupPrimaryEnsNameResult).mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectLookup = reject;
      })
  );
  await expect(findEnsForRefresh('0xaddress', 20)).resolves.toEqual({
    status: 'unavailable'
  });
  const provider = jest.mocked(lookupPrimaryEnsNameResult).mock.calls[0][1];
  expect(() => provider._getConnection()).toThrow();
  rejectLookup(new Error('Late resolver failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

it.each(['0x', '', 'not-json'])(
  'preserves the CCIP data contract for %j',
  async (data) => {
    jest
      .spyOn(FetchRequest.prototype, 'send')
      .mockImplementation(async function (this: FetchRequest) {
        const body = data === 'not-json' ? data : JSON.stringify({ data });
        return new FetchResponse(200, 'OK', {}, Buffer.from(body), this);
      });
    const provider = createEnsRefreshProvider(1000);
    try {
      const result = provider.ccipReadFetch({ to: '0xabc' }, '0x1234', [
        'https://gateway.test'
      ]);
      if (data === '0x') await expect(result).resolves.toBe('0x');
      else
        await expect(result).rejects.toMatchObject({ code: 'OFFCHAIN_FAULT' });
    } finally {
      provider.destroy();
    }
  }
);

it('fails visibly when the RPC endpoint is not configured', async () => {
  delete process.env.ETHEREUM_RPC_URL;
  await expect(findEnsForRefresh('0xaddress', 100)).rejects.toThrow(
    'ETHEREUM_RPC_URL'
  );
});

it('rejects a wrong-chain endpoint instead of trusting the configured chain', async () => {
  const provider = createEnsRefreshProvider(1000);
  jest.spyOn(provider, '_send').mockImplementation(async (payload) =>
    (Array.isArray(payload) ? payload : [payload]).map(({ id }) => ({
      id,
      result: '0x89'
    }))
  );
  try {
    await expect(provider.getNetwork()).rejects.toThrow(/network changed/);
  } finally {
    provider.destroy();
  }
});

it.each(['rpc', 'ccip', 'ccip-redirect'] as const)(
  'cancels an active %s HTTP request on disposal',
  async (kind) => {
    let received!: () => void;
    const started = new Promise<void>((resolve) => {
      received = resolve;
    });
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      closed = resolve;
    });
    server = createServer((req, response) => {
      if (kind === 'ccip-redirect' && req.url === '/') {
        response.writeHead(302, { location: `${url}/pending` });
        response.end();
        return;
      }
      req.socket.once('close', closed);
      received();
      // Deliberately never respond.
    });
    server.on('connection', (socket) => sockets.add(socket));
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test server');
    const url = `http://127.0.0.1:${address.port}`;
    process.env.ETHEREUM_RPC_URL = url;
    const provider = createEnsRefreshProvider(10_000);
    const pending =
      kind === 'rpc'
        ? provider._getConnection().send()
        : provider.ccipReadFetch(
            { to: '0x1111111111111111111111111111111111111111' },
            '0xabcd',
            [url]
          );
    const checked = expect(pending).rejects.toThrow();
    await started;
    provider.destroy();
    await checked;
    await disconnected;
  }
);

it.each([404, 502])(
  'preserves CCIP gateway fallback for HTTP %s',
  async (status) => {
    const send = jest
      .spyOn(FetchRequest.prototype, 'send')
      .mockImplementationOnce(async function (this: FetchRequest) {
        return new FetchResponse(
          status,
          'Unavailable',
          {},
          Buffer.from('{}'),
          this
        );
      })
      .mockImplementationOnce(async function (this: FetchRequest) {
        return new FetchResponse(
          200,
          'OK',
          {},
          Buffer.from('{"data":"0xbeef"}'),
          this
        );
      });
    const provider = createEnsRefreshProvider(1000);
    try {
      const result = provider.ccipReadFetch({ to: '0xabc' }, '0x1234', [
        'https://gateway.test/first',
        'https://gateway.test/second'
      ]);
      if (status === 404) {
        await expect(result).rejects.toMatchObject({
          code: 'OFFCHAIN_FAULT',
          reason: '404_MISSING_RESOURCE'
        });
        expect(send).toHaveBeenCalledTimes(1);
      } else {
        await expect(result).resolves.toBe('0xbeef');
        expect(send).toHaveBeenCalledTimes(2);
      }
    } finally {
      provider.destroy();
    }
  }
);

it.each([true, false])(
  'preserves CCIP GET/POST expansion (GET=%s)',
  async (get) => {
    const send = jest
      .spyOn(FetchRequest.prototype, 'send')
      .mockImplementation(async function (this: FetchRequest) {
        expect(this.timeout).toBeLessThanOrEqual(1000);
        expect(this.url).toBe(
          get
            ? 'https://gateway.test/0xabc/0x1234'
            : 'https://gateway.test/0xabc'
        );
        if (!get)
          expect(JSON.parse(Buffer.from(this.body!).toString())).toEqual({
            data: '0x1234',
            sender: '0xabc'
          });
        return new FetchResponse(
          200,
          'OK',
          {},
          Buffer.from('{"data":"0xbeef"}'),
          this
        );
      });
    const provider = createEnsRefreshProvider(1000);
    try {
      await expect(
        provider.ccipReadFetch({ to: '0xABC' }, '0x1234', [
          get
            ? 'https://gateway.test/{sender}/{data}'
            : 'https://gateway.test/{sender}'
        ])
      ).resolves.toBe('0xbeef');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      provider.destroy();
    }
  }
);
