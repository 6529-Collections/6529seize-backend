import * as os from 'node:os';
import * as path from 'node:path';
import { startAnvil } from '@/rebuild/sources/anvil';

// Needs anvil (Foundry). Runs with scripts/rebuild-jest.config.cjs.

async function rpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const answer = (await response.json()) as {
    result?: any;
    error?: { message: string };
  };
  if (answer.error) throw new Error(answer.error.message);
  return answer.result;
}

describe('anvil behind the Alchemy shim', () => {
  it('passes standard calls through and builds asset transfers from blocks', async () => {
    const source = await startAnvil({
      state: null,
      logFile: path.join(os.tmpdir(), 'rebuild-anvil-test.log')
    });
    try {
      expect(await rpc(source.url, 'eth_chainId', [])).toBe('0x1');
      const [from, to] = await rpc(source.url, 'eth_accounts', []);
      const hash = await rpc(source.url, 'eth_sendTransaction', [
        { from, to, value: '0xde0b6b3a7640000' }
      ]);
      const result = await rpc(source.url, 'alchemy_getAssetTransfers', [
        { fromBlock: '0x0', category: ['external'], withMetadata: true }
      ]);
      expect(result.transfers).toEqual([
        expect.objectContaining({
          hash,
          from: from.toLowerCase(),
          to: to.toLowerCase(),
          value: 1,
          category: 'external'
        })
      ]);
      expect(source.info).toMatchObject({ mode: 'local', provisional: false });
      expect(source.problems()).toEqual([]);
    } finally {
      await source.stop();
    }
  });
});
