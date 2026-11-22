import { EthBlockReader } from '../chain-day-verify';
import { bodyJson, RateLimitedFetcher } from '../rate-limited-fetcher';

/**
 * Ethereum blocks by number over plain JSON-RPC (`eth_getBlockByNumber`),
 * paced by the same fetcher, for the CLI's optional cutoff check. The site's
 * loop uses its own RPC client instead.
 */
export function jsonRpcBlockReader(
  fetcher: RateLimitedFetcher,
  url: string
): EthBlockReader {
  let id = 0;
  return {
    async getBlock(n: number) {
      id++;
      const res = await fetcher.postJson(url, {
        jsonrpc: '2.0',
        id,
        method: 'eth_getBlockByNumber',
        params: [`0x${n.toString(16)}`, false]
      });
      const block = bodyJson(res)?.result;
      if (!block || typeof block.hash !== 'string') {
        throw new Error(`Ethereum block ${n} not found`);
      }
      return {
        hash: block.hash.toLowerCase(),
        timestamp: Number(block.timestamp)
      };
    }
  };
}
