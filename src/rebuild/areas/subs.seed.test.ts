import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { discoverTopUps } from '@/subscriptionsTopUpLoop/subscription_topups';
import { anvilTopUps } from './subs.seed';

jest.mock('@/subscriptionsTopUpLoop/subscription_topups', () => ({
  discoverTopUps: jest.fn()
}));

const WALLET = '0x00000000000000000000000000000000000000c2';

/**
 * A JSON-RPC stand-in for the run's anvil on loopback: it records each
 * method called, in order, and answers the ones in `failing` with an error.
 */
async function rpcStub(failing: Record<string, string>) {
  const methods: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      methods.push(method);
      const answer =
        method in failing
          ? { jsonrpc: '2.0', id, error: { message: failing[method] } }
          : { jsonrpc: '2.0', id, result: null };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    methods,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

describe("the subscriptions seeds' top-ups on anvil", () => {
  let stub: Awaited<ReturnType<typeof rpcStub>> | null = null;

  afterEach(async () => {
    await stub?.close();
    stub = null;
    (discoverTopUps as jest.Mock).mockReset();
  });

  it("stop impersonating the wallet and throw the transfer's own error when the transfer fails", async () => {
    stub = await rpcStub({ eth_sendTransaction: 'insufficient funds' });
    await expect(anvilTopUps(stub.url)(WALLET, '0.1')).rejects.toThrow(
      'eth_sendTransaction: insufficient funds'
    );
    expect(stub.methods).toEqual([
      'anvil_impersonateAccount',
      'anvil_setBalance',
      'eth_sendTransaction',
      'anvil_stopImpersonatingAccount'
    ]);
    expect(discoverTopUps).not.toHaveBeenCalled();
  });

  it("keep the failed call's error when stopping the impersonation fails too", async () => {
    stub = await rpcStub({
      anvil_setBalance: 'no such account',
      anvil_stopImpersonatingAccount: 'not impersonated'
    });
    await expect(anvilTopUps(stub.url)(WALLET, '0.1')).rejects.toThrow(
      'anvil_setBalance: no such account'
    );
    expect(stub.methods).toEqual([
      'anvil_impersonateAccount',
      'anvil_setBalance',
      'anvil_stopImpersonatingAccount'
    ]);
    expect(discoverTopUps).not.toHaveBeenCalled();
  });

  it('stop impersonating before mining past the finality gap, then run discovery', async () => {
    stub = await rpcStub({});
    await anvilTopUps(stub.url)(WALLET, '0.1');
    expect(stub.methods).toEqual([
      'anvil_impersonateAccount',
      'anvil_setBalance',
      'eth_sendTransaction',
      'anvil_stopImpersonatingAccount',
      'anvil_mine'
    ]);
    expect(discoverTopUps).toHaveBeenCalledTimes(1);
  });
});
