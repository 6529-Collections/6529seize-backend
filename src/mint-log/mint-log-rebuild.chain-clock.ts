import fetch from 'node-fetch';
import { Time } from '@/time';

/**
 * The rebuild check's clock for what depends on time having passed: the
 * time of the run's mark block on its ethereum source (`--eth-block`), or of
 * the head block when the run names none. The holdings fixture mines its
 * blocks hours apart, so its mints have closed on this clock while the wall
 * clock says they were minted minutes ago. Production keeps the wall clock.
 * Not 'finalized': on anvil it is only about 12 h past the fixture's mints,
 * before they close.
 */
export async function chainHeadTime(
  ethereumUrl: string,
  markBlock: number | null = null,
  fetchImpl: typeof fetch = fetch
): Promise<Time> {
  const response = await fetchImpl(ethereumUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBlockByNumber',
      params: [
        markBlock === null ? 'latest' : `0x${markBlock.toString(16)}`,
        false
      ]
    })
  });
  if (!response.ok) {
    throw new Error(`The ethereum source answered ${response.status}`);
  }
  const answer = (await response.json()) as {
    result?: { timestamp?: string } | null;
    error?: { message?: string };
  };
  const seconds = Number.parseInt(answer.result?.timestamp ?? '', 16);
  if (!Number.isFinite(seconds)) {
    throw new Error(
      `The ethereum source gave no head block time${answer.error?.message ? `: ${answer.error.message}` : ''}`
    );
  }
  return Time.seconds(seconds);
}
