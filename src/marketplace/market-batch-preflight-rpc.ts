import { getRpcUrl } from '@/alchemy';
import { MarketBatchPrepared } from '@/marketplace/market-batch.types';
import { MarketValidationError } from '@/marketplace/provider.types';
import { z } from 'zod';

const quantity = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i);
const blockSchema = z.object({
  number: quantity,
  hash: z.string().regex(/^0x[0-9a-f]{64}$/i),
  timestamp: quantity
});
const MAX_RESPONSE_BYTES = 2_000_000;

function unavailable(): never {
  throw new MarketValidationError(
    'PROVIDER_UNAVAILABLE',
    'The batch checks could not finish. Try again.'
  );
}

async function readJson(
  response: Response,
  signal: AbortSignal
): Promise<unknown> {
  if (!response.ok || !response.body) unavailable();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) unavailable();
      text += decoder.decode(chunk.value, { stream: true });
    }
    signal.throwIfAborted();
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** No caller-supplied method, transport, block or transaction overrides. */
async function rpc(
  method: 'eth_getBlockByNumber' | 'eth_call' | 'eth_estimateGas',
  params: unknown[],
  signal: AbortSignal
): Promise<unknown> {
  signal.throwIfAborted();
  if (!process.env.ALCHEMY_API_KEY) unavailable();
  const response = await fetch(getRpcUrl(1), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    redirect: 'error',
    signal
  });
  const result = z
    .object({
      jsonrpc: z.literal('2.0'),
      id: z.literal(1),
      result: z.unknown().optional(),
      error: z
        .object({ code: z.number(), message: z.string() })
        .passthrough()
        .optional()
    })
    .parse(await readJson(response, signal));
  if (result.error) {
    // Never propagate provider bodies, RPC data, URLs or seller authorizations.
    if (
      result.error.code === 3 ||
      (result.error.code === -32000 &&
        /execution reverted/i.test(result.error.message))
    )
      throw new MarketValidationError(
        'ORDER_MISMATCH',
        'The complete batch can no longer be executed. Review the listings again.'
      );
    unavailable();
  }
  if (!('result' in result)) unavailable();
  return result.result;
}

function snapshot(value: unknown) {
  const block = blockSchema.parse(value);
  const block_number = Number(BigInt(block.number));
  const block_timestamp = Number(BigInt(block.timestamp));
  if (
    !Number.isSafeInteger(block_number) ||
    block_number <= 0 ||
    !Number.isSafeInteger(block_timestamp) ||
    block_timestamp <= 0 ||
    Date.now() - block_timestamp * 1000 > 120_000 ||
    block_timestamp * 1000 - Date.now() > 30_000
  )
    unavailable();
  return { block_number, block_hash: block.hash, block_timestamp };
}

/** Pin BOTH raw RPC methods; ethers estimateGas does not forward a blockTag. */
export async function simulateStoredMarketBatch(
  prepared: MarketBatchPrepared,
  signal: AbortSignal
) {
  try {
    const block = snapshot(
      await rpc('eth_getBlockByNumber', ['latest', false], signal)
    );
    if (
      block.block_number < prepared.snapshot.block_number ||
      block.block_timestamp < prepared.snapshot.block_timestamp
    )
      unavailable();
    const tag = `0x${block.block_number.toString(16)}`;
    const tx = prepared.transaction;
    const transaction = {
      from: tx.from,
      to: tx.to,
      data: tx.data,
      value: `0x${BigInt(tx.value).toString(16)}`
    };
    const result = await rpc('eth_call', [transaction, tag], signal);
    if (typeof result !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(result))
      unavailable();
    const estimated = quantity.parse(
      await rpc('eth_estimateGas', [transaction, tag], signal)
    );
    const gas = BigInt(estimated);
    if (gas <= BigInt(0) || gas > BigInt(16_777_216)) unavailable();
    const canonical = snapshot(
      await rpc('eth_getBlockByNumber', [tag, false], signal)
    );
    if (
      canonical.block_number !== block.block_number ||
      canonical.block_hash.toLowerCase() !== block.block_hash.toLowerCase() ||
      canonical.block_timestamp !== block.block_timestamp
    )
      unavailable();
    signal.throwIfAborted();
    return { ...block, estimated_gas: gas.toString() };
  } catch (error) {
    if (error instanceof MarketValidationError) throw error;
    unavailable();
  }
}
