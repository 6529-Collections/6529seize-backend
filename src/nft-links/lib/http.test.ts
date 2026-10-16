import { createServer } from 'node:http';
import { once } from 'node:events';
import { fetchTextWithTimeout, NftLinkHttpTimeoutError } from './http';
import { withNftLinkResolutionBudget } from '@/nft-links/resolution-budget';

it('identifies refresher HTTP timeouts while preserving cancellation for other callers', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.flushHeaders();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test listener');
  const url = `http://127.0.0.1:${address.port}/synthetic`;
  try {
    await expect(
      withNftLinkResolutionBudget(5000, () =>
        fetchTextWithTimeout(url, { timeoutMs: 30 })
      )
    ).rejects.toBeInstanceOf(NftLinkHttpTimeoutError);
    await expect(
      fetchTextWithTimeout(url, { timeoutMs: 30 })
    ).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
