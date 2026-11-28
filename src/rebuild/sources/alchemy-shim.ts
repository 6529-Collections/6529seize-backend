import * as http from 'node:http';
import { AbiCoder } from 'ethers';
import {
  closeServer,
  errorText,
  listenLoopback,
  readBody
} from '@/rebuild/sources/running-source';

/**
 * Answers the Alchemy-only calls the backend's loops make from a plain
 * Ethereum node (anvil), and passes every standard JSON-RPC call through.
 * `alchemy_getAssetTransfers` is built from logs and blocks; the NFT API is
 * not served and is reported, so an area that needs it says so.
 */

export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const TRANSFER_SINGLE_TOPIC =
  '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
export const TRANSFER_BATCH_TOPIC =
  '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';

export interface RpcLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly logIndex: string;
}

export interface RpcTransaction {
  readonly hash: string;
  readonly from: string;
  readonly to: string | null;
  readonly value: string;
}

export interface AssetTransfer {
  readonly blockNum: string;
  readonly uniqueId: string;
  readonly hash: string;
  readonly from: string;
  readonly to: string;
  readonly value: number | null;
  readonly erc721TokenId: string | null;
  readonly erc1155Metadata: { tokenId: string; value: string }[] | null;
  readonly tokenId: string | null;
  readonly asset: string | null;
  readonly category: string;
  readonly rawContract: {
    readonly value: string | null;
    readonly address: string | null;
    readonly decimal: string | null;
  };
  readonly metadata: { readonly blockTimestamp: string };
  /** Sort position within the block; not sent. */
  readonly order: number;
}

export interface TransferQuery {
  readonly fromBlock?: string;
  readonly toBlock?: string;
  readonly fromAddress?: string;
  readonly toAddress?: string;
  readonly contractAddresses?: string[];
  readonly category?: string[];
  readonly excludeZeroValue?: boolean;
  readonly maxCount?: string;
  readonly pageKey?: string;
  readonly order?: 'asc' | 'desc';
  readonly withMetadata?: boolean;
}

const coder = AbiCoder.defaultAbiCoder();
const DEFAULT_MAX_COUNT = 1000;

function topicAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/** Transfers in one log: ERC-20, ERC-721, or ERC-1155 single and batch. */
export function transfersOfLog(
  log: RpcLog,
  blockTimestamp: string
): AssetTransfer[] {
  const base = {
    blockNum: log.blockNumber,
    hash: log.transactionHash,
    asset: null,
    rawContract: {
      value: null,
      address: log.address.toLowerCase(),
      decimal: null
    },
    metadata: { blockTimestamp },
    order: Number(BigInt(log.logIndex))
  };
  const uniqueId = `${log.transactionHash}:log:${Number(BigInt(log.logIndex))}`;
  const [topic] = log.topics;
  if (topic === TRANSFER_TOPIC && log.topics.length === 4) {
    const tokenId = hex(BigInt(log.topics[3]));
    return [
      {
        ...base,
        uniqueId,
        from: topicAddress(log.topics[1]),
        to: topicAddress(log.topics[2]),
        value: null,
        erc721TokenId: tokenId,
        erc1155Metadata: null,
        tokenId,
        category: 'erc721'
      }
    ];
  }
  if (topic === TRANSFER_TOPIC && log.topics.length === 3) {
    const [amount] = coder.decode(['uint256'], log.data);
    return [
      {
        ...base,
        uniqueId,
        from: topicAddress(log.topics[1]),
        to: topicAddress(log.topics[2]),
        value: Number(amount),
        erc721TokenId: null,
        erc1155Metadata: null,
        tokenId: null,
        category: 'erc20',
        rawContract: { ...base.rawContract, value: hex(amount as bigint) }
      }
    ];
  }
  if (topic === TRANSFER_SINGLE_TOPIC || topic === TRANSFER_BATCH_TOPIC) {
    const single = topic === TRANSFER_SINGLE_TOPIC;
    const [ids, values] = single
      ? coder.decode(['uint256', 'uint256'], log.data).map((v) => [v])
      : coder.decode(['uint256[]', 'uint256[]'], log.data);
    const metadata = (ids as bigint[]).map((id, i) => ({
      tokenId: hex(id),
      value: hex((values as bigint[])[i])
    }));
    return [
      {
        ...base,
        uniqueId,
        from: topicAddress(log.topics[2]),
        to: topicAddress(log.topics[3]),
        value: null,
        erc721TokenId: null,
        erc1155Metadata: metadata,
        tokenId: null,
        category: 'erc1155'
      }
    ];
  }
  return [];
}

/** A top-level ETH transfer, as Alchemy's `external` category. */
export function transferOfTransaction(
  tx: RpcTransaction,
  blockNumber: string,
  blockTimestamp: string,
  position: number
): AssetTransfer {
  const wei = BigInt(tx.value);
  return {
    blockNum: blockNumber,
    uniqueId: `${tx.hash}:external`,
    hash: tx.hash,
    from: tx.from.toLowerCase(),
    to: (tx.to ?? '').toLowerCase(),
    value: Number(wei) / 1e18,
    erc721TokenId: null,
    erc1155Metadata: null,
    tokenId: null,
    asset: 'ETH',
    category: 'external',
    rawContract: { value: hex(wei), address: null, decimal: '0x12' },
    metadata: { blockTimestamp },
    order: -1_000_000 + position
  };
}

/** Filters, orders and pages transfers as `alchemy_getAssetTransfers` does. */
export function selectTransfers(
  transfers: readonly AssetTransfer[],
  query: TransferQuery
): { transfers: Omit<AssetTransfer, 'order'>[]; pageKey?: string } {
  const from = query.fromAddress?.toLowerCase();
  const to = query.toAddress?.toLowerCase();
  const contracts = query.contractAddresses?.map((c) => c.toLowerCase());
  const categories = query.category ?? [
    'external',
    'erc20',
    'erc721',
    'erc1155'
  ];
  const excludeZero = query.excludeZeroValue ?? true;
  const selected = transfers
    .filter((t) => categories.includes(t.category))
    .filter((t) => !from || t.from === from)
    .filter((t) => !to || t.to === to)
    .filter(
      (t) =>
        !contracts ||
        (t.rawContract.address !== null &&
          contracts.includes(t.rawContract.address))
    )
    .filter((t) => !(excludeZero && t.category === 'external' && t.value === 0))
    .sort(
      (a, b) =>
        Number(BigInt(a.blockNum) - BigInt(b.blockNum)) || a.order - b.order
    );
  if (query.order === 'desc') selected.reverse();
  const offset = query.pageKey ? Number(query.pageKey) : 0;
  const max = query.maxCount
    ? Number(BigInt(query.maxCount))
    : DEFAULT_MAX_COUNT;
  const page = selected
    .slice(offset, offset + max)
    .map(({ order: _order, ...rest }) => rest);
  return offset + max < selected.length
    ? { transfers: page, pageKey: String(offset + max) }
    : { transfers: page };
}

type Rpc = (method: string, params: unknown[]) => Promise<any>;

async function collectTransfers(
  rpc: Rpc,
  query: TransferQuery
): Promise<AssetTransfer[]> {
  const latest = BigInt(await rpc('eth_blockNumber', []));
  const resolve = (tag: string | undefined, fallback: bigint) =>
    !tag || tag === 'latest' ? fallback : BigInt(tag);
  const fromBlock = resolve(query.fromBlock, BigInt(0));
  const toBlock = resolve(query.toBlock, latest);
  const timestamps = new Map<string, string>();
  const blockOf = async (number: bigint) => {
    const block = await rpc('eth_getBlockByNumber', [hex(number), true]);
    timestamps.set(
      hex(number),
      new Date(Number(BigInt(block.timestamp)) * 1000).toISOString()
    );
    return block;
  };
  const transfers: AssetTransfer[] = [];
  const categories = query.category ?? [
    'external',
    'erc20',
    'erc721',
    'erc1155'
  ];
  if (categories.includes('external')) {
    for (let n = fromBlock; n <= toBlock; n++) {
      const block = await blockOf(n);
      (block.transactions as RpcTransaction[]).forEach((tx, i) =>
        transfers.push(
          transferOfTransaction(tx, hex(n), timestamps.get(hex(n))!, i)
        )
      );
    }
  }
  if (categories.some((c) => c !== 'external')) {
    const logs: RpcLog[] = await rpc('eth_getLogs', [
      {
        fromBlock: hex(fromBlock),
        toBlock: hex(toBlock),
        ...(query.contractAddresses
          ? { address: query.contractAddresses }
          : {}),
        topics: [[TRANSFER_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]]
      }
    ]);
    for (const log of logs) {
      const key = hex(BigInt(log.blockNumber));
      if (!timestamps.has(key)) await blockOf(BigInt(log.blockNumber));
      transfers.push(...transfersOfLog(log, timestamps.get(key)!));
    }
  }
  return transfers;
}

/**
 * Starts the shim on loopback in front of `nodeUrl`. Standard JSON-RPC
 * methods go to the node unchanged; the NFT API and other alchemy_* methods
 * are refused and reported as the source's problems. A call the shim fails
 * on answers a JSON-RPC error with a fixed message; the error itself goes
 * to the source's problems, so it reaches the run's report and log.
 */
export async function startAlchemyShim(nodeUrl: string): Promise<{
  readonly url: string;
  problems(): string[];
  stop(): Promise<void>;
}> {
  const unsupported: string[] = [];
  const failed: string[] = [];
  const rpc: Rpc = async (method, params) => {
    const response = await fetch(nodeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    const answer = (await response.json()) as {
      result?: any;
      error?: { message: string };
    };
    if (answer.error) throw new Error(`${method}: ${answer.error.message}`);
    return answer.result;
  };
  const server = http.createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method !== 'POST') {
        unsupported.push(`${request.method} ${request.url}`);
        send(501, {
          error: 'the Alchemy NFT API is not served by the rebuild check'
        });
        return;
      }
      const body = await readBody(request);
      // The NFT API (also POST, under /nft/) and Alchemy's other
      // enhanced methods are not served: refused and reported, never
      // passed to the node to fail there unseen.
      if ((request.url ?? '').includes('/nft/')) {
        unsupported.push(`POST ${request.url}`);
        send(501, {
          error: 'the Alchemy NFT API is not served by the rebuild check'
        });
        return;
      }
      const call = JSON.parse(body.toString('utf8'));
      // A batch is checked call by call: one unserved method refuses it.
      const calls: { method?: unknown; id?: unknown }[] = Array.isArray(call)
        ? call
        : [call];
      const unserved = calls
        .map((c) => c?.method)
        .filter(
          (method): method is string =>
            typeof method === 'string' &&
            method.startsWith('alchemy_') &&
            (Array.isArray(call) || method !== 'alchemy_getAssetTransfers')
        );
      if (unserved.length) {
        unsupported.push(...unserved);
        const refusal = (c: { id?: unknown }) => ({
          jsonrpc: '2.0',
          id: c?.id ?? null,
          error: {
            code: -32601,
            message: `${unserved.join(', ')} is not served by the rebuild check`
          }
        });
        send(200, Array.isArray(call) ? calls.map(refusal) : refusal(call));
        return;
      }
      if (call.method !== 'alchemy_getAssetTransfers') {
        const upstream = await fetch(nodeUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body
        });
        response.writeHead(upstream.status, {
          'content-type': 'application/json'
        });
        response.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      const query = (call.params?.[0] ?? {}) as TransferQuery;
      const result = selectTransfers(await collectTransfers(rpc, query), query);
      send(200, { jsonrpc: '2.0', id: call.id, result });
    } catch (error) {
      failed.push(errorText(error));
      // A passthrough answer whose body failed has its headers out already.
      if (response.headersSent) {
        response.destroy();
        return;
      }
      send(200, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'shim error' }
      });
    }
  });
  const { url } = await listenLoopback(server);
  return {
    url,
    problems: () => [
      ...(unsupported.length
        ? [
            `ethereum: ${unsupported.length} Alchemy calls the run doesn't serve (the NFT API or enhanced methods); first ${unsupported.slice(0, 3).join(', ')}`
          ]
        : []),
      ...(failed.length
        ? [
            `ethereum: ${failed.length} calls failed in the Alchemy stand-in, first ${failed.slice(0, 3).join('; ')}`
          ]
        : [])
    ],
    stop: () => closeServer(server)
  };
}
