import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  AbiCoder,
  Interface,
  id as keccakText,
  toBeHex,
  zeroPadValue
} from 'ethers';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  NULL_ADDRESS
} from '@/constants';
import { MANIFOLD_LAZY_CLAIM_CONTRACT } from '@/constants/manifold';

/**
 * A small Ethereum for the rebuild tests: three Memes transactions, the
 * blocks around them, the contract calls the NFT loop makes and the token
 * metadata. It is written, not recorded (no test may call a provider), in
 * the shapes the node and Alchemy answer with. The server answers only what
 * the cassette holds and lists every other request, so a test can fail on
 * any call it did not expect.
 *
 * Block 101: the admin mints cards 1, 2 and 3 of season 1 to wallet 1, two
 *   of card 1 and one of each other (mintBaseNew). A season needs three
 *   cards: the balances code's card-set count fails on fewer.
 * Block 102: wallet 1 sends one of card 1 to wallet 2.
 * Block 103: the admin sets card 1's token URI. Manifold's creator contract
 *   emits no URI event for this; the cassette adds one so the history
 *   step's URI-event query is exercised as well as its creator-call query.
 */

export const WALLET_1 = '0x0000000000000000000000000000000000000001';
export const WALLET_2 = '0x0000000000000000000000000000000000000002';
export const ADMIN = '0x000000000000000000000000000000000000000a';
export const MARK_BLOCK = 110;
export const FINALIZED_BLOCK = 112;
const FIRST_TIMESTAMP = Date.UTC(2026, 0, 2, 12, 0, 0) / 1000;

const arweave = (name: string) =>
  `https://arweave.net/${name.padEnd(43, '0').slice(0, 43)}`;
const firstUri = (card: number) =>
  arweave(`rebuildCassetteCard${card}FirstUri`);
export const CARD_1_SECOND_URI = arweave('rebuildCassetteCard1SecondUri');

export function cardMetadata(card: number, edition: string) {
  const name = `Cassette Card ${card}`;
  return {
    name,
    description: `${name}, ${edition} edition`,
    image: arweave(`rebuildCassetteImage${card}${edition}`),
    image_details: { format: 'PNG', width: 100, height: 100 },
    attributes: [
      { trait_type: 'Artist', value: 'Cassette Artist' },
      { trait_type: 'SEIZE Artist Profile', value: 'cassette-artist' },
      { trait_type: 'Meme Name', value: `Cassette ${card}` },
      { trait_type: 'Type - Season', value: 1 },
      { trait_type: 'Type - Meme', value: card },
      { trait_type: 'Type - Card', value: card }
    ]
  };
}

/** Metadata by URI; the gateways may be asked for either form of it. */
export const METADATA: Record<string, unknown> = {
  [firstUri(1)]: cardMetadata(1, 'first'),
  [firstUri(2)]: cardMetadata(2, 'first'),
  [firstUri(3)]: cardMetadata(3, 'first'),
  [CARD_1_SECOND_URI]: cardMetadata(1, 'second')
};

const CREATOR = new Interface([
  'function mintBaseNew(address[] to,uint256[] amounts,string[] uris) returns (uint256[])',
  'function setTokenURI(uint256 tokenId,string uri_)',
  'function safeTransferFrom(address from,address to,uint256 id,uint256 amount,bytes data)',
  'function uri(uint256 tokenId) view returns (string)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'event URI(string value,uint256 indexed id)'
]);
const coder = AbiCoder.defaultAbiCoder();
const word = (value: string) => zeroPadValue(value, 32);

interface CassetteLog {
  readonly address: string;
  readonly topics: string[];
  readonly data: string;
}

export interface CassetteTransaction {
  readonly hash: string;
  readonly blockNumber: number;
  readonly index: number;
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
  readonly input: string;
  readonly logs: CassetteLog[];
}

function transferSingle(
  operator: string,
  from: string,
  to: string,
  tokenId: number,
  amount: number
): CassetteLog {
  const event = CREATOR.getEvent('TransferSingle')!;
  return {
    address: MEMES_CONTRACT,
    topics: [event.topicHash, word(operator), word(from), word(to)],
    data: coder.encode(['uint256', 'uint256'], [tokenId, amount])
  };
}

const txHash = (n: number) => keccakText(`rebuild cassette transaction ${n}`);
export const blockHash = (n: number) =>
  keccakText(`rebuild cassette block ${n}`);

export const TRANSACTIONS: CassetteTransaction[] = [
  {
    hash: txHash(1),
    blockNumber: 101,
    index: 0,
    from: ADMIN,
    to: MEMES_CONTRACT,
    value: BigInt(0),
    input: CREATOR.encodeFunctionData('mintBaseNew', [
      [WALLET_1],
      [2, 1, 1],
      [firstUri(1), firstUri(2), firstUri(3)]
    ]),
    logs: [
      transferSingle(ADMIN, NULL_ADDRESS, WALLET_1, 1, 2),
      transferSingle(ADMIN, NULL_ADDRESS, WALLET_1, 2, 1),
      transferSingle(ADMIN, NULL_ADDRESS, WALLET_1, 3, 1)
    ]
  },
  {
    hash: txHash(2),
    blockNumber: 102,
    index: 0,
    from: WALLET_1,
    to: MEMES_CONTRACT,
    value: BigInt(0),
    input: CREATOR.encodeFunctionData('safeTransferFrom', [
      WALLET_1,
      WALLET_2,
      1,
      1,
      '0x'
    ]),
    logs: [transferSingle(WALLET_1, WALLET_1, WALLET_2, 1, 1)]
  },
  {
    hash: txHash(3),
    blockNumber: 103,
    index: 0,
    from: ADMIN,
    to: MEMES_CONTRACT,
    value: BigInt(0),
    input: CREATOR.encodeFunctionData('setTokenURI', [1, CARD_1_SECOND_URI]),
    logs: [
      {
        address: MEMES_CONTRACT,
        topics: [CREATOR.getEvent('URI')!.topicHash, toBeHex(1, 32)],
        data: coder.encode(['string'], [CARD_1_SECOND_URI])
      }
    ]
  }
];

const revertData = (reason: string) =>
  '0x08c379a0' + coder.encode(['string'], [reason]).slice(2);

const LAZY_CLAIM = new Interface([
  'function getClaimForToken(address creatorContractAddress,uint256 tokenId)'
]);

/**
 * The NFT loop's reads at the latest block: token URIs, and the newest
 * Meme's claim (none: these cards were minted directly, not claimed).
 */
const CALLS: {
  to: string;
  data: string;
  result?: string;
  revert?: string;
}[] = [
  {
    to: MEMES_CONTRACT,
    data: CREATOR.encodeFunctionData('uri', [1]),
    result: coder.encode(['string'], [CARD_1_SECOND_URI])
  },
  {
    to: MEMES_CONTRACT,
    data: CREATOR.encodeFunctionData('uri', [2]),
    result: coder.encode(['string'], [firstUri(2)])
  },
  {
    to: MEMES_CONTRACT,
    data: CREATOR.encodeFunctionData('uri', [3]),
    result: coder.encode(['string'], [firstUri(3)])
  },
  {
    to: MEMES_CONTRACT,
    data: CREATOR.encodeFunctionData('uri', [4]),
    revert: 'Invalid token'
  },
  {
    to: MANIFOLD_LAZY_CLAIM_CONTRACT,
    data: LAZY_CLAIM.encodeFunctionData('getClaimForToken', [
      MEMES_CONTRACT,
      3
    ]),
    revert: 'Claim not initialized'
  },
  {
    to: MEMELAB_CONTRACT,
    data: CREATOR.encodeFunctionData('uri', [1]),
    revert: 'Invalid token'
  },
  {
    to: GRADIENT_CONTRACT,
    data: CREATOR.encodeFunctionData('tokenURI', [0]),
    revert: 'ERC721Metadata: URI query for nonexistent token'
  }
];

const hex = (value: number | bigint) => toBeHex(value);
const same = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
const timestamp = (block: number) => FIRST_TIMESTAMP + (block - 101) * 12;

function block(number: number, full = false) {
  if (number < 0 || number > FINALIZED_BLOCK) return null;
  const transactions = TRANSACTIONS.filter((t) => t.blockNumber === number);
  return {
    number: hex(number),
    hash: blockHash(number),
    parentHash: number ? blockHash(number - 1) : word('0x00'),
    timestamp: hex(timestamp(number)),
    nonce: '0x0000000000000000',
    difficulty: '0x0',
    gasLimit: hex(30_000_000),
    gasUsed: hex(transactions.length * 100_000),
    miner: word('0x00').slice(0, 42),
    extraData: '0x',
    baseFeePerGas: hex(1_000_000_000),
    transactions: full
      ? transactions.map(rpcTransaction)
      : transactions.map((t) => t.hash)
  };
}

function rpcTransaction(t: CassetteTransaction) {
  return {
    hash: t.hash,
    blockHash: blockHash(t.blockNumber),
    blockNumber: hex(t.blockNumber),
    transactionIndex: hex(t.index),
    from: t.from,
    to: t.to,
    value: hex(t.value),
    input: t.input,
    gas: hex(200_000),
    gasPrice: hex(1_000_000_000),
    nonce: hex(t.blockNumber),
    type: '0x0',
    chainId: '0x1',
    v: '0x25',
    r: word('0x11'),
    s: word('0x22')
  };
}

function rpcLogs(t: CassetteTransaction) {
  return t.logs.map((log, index) => ({
    ...log,
    blockHash: blockHash(t.blockNumber),
    blockNumber: hex(t.blockNumber),
    transactionHash: t.hash,
    transactionIndex: hex(t.index),
    logIndex: hex(index),
    removed: false
  }));
}

function receipt(t: CassetteTransaction) {
  return {
    transactionHash: t.hash,
    transactionIndex: hex(t.index),
    blockHash: blockHash(t.blockNumber),
    blockNumber: hex(t.blockNumber),
    from: t.from,
    to: t.to,
    contractAddress: null,
    cumulativeGasUsed: hex(100_000),
    gasUsed: hex(100_000),
    effectiveGasPrice: hex(1_000_000_000),
    logs: rpcLogs(t),
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    type: '0x0'
  };
}

function blockNumberOf(tag: unknown): number {
  if (
    tag === undefined ||
    tag === 'latest' ||
    tag === 'finalized' ||
    tag === 'safe'
  )
    return FINALIZED_BLOCK;
  if (tag === 'earliest') return 0;
  if (typeof tag === 'string' && tag.startsWith('0x')) return Number(tag);
  throw new Error(`Unexpected block tag ${String(tag)}`);
}

function topicMatches(wanted: unknown, actual: string | undefined): boolean {
  if (wanted === null || wanted === undefined) return true;
  if (Array.isArray(wanted)) return wanted.some((w) => same(w, actual));
  return same(wanted as string, actual);
}

function logs(filter: {
  fromBlock?: string;
  toBlock?: string;
  address?: string | string[];
  topics?: unknown[];
}) {
  const from = blockNumberOf(filter.fromBlock ?? 'earliest');
  const to = blockNumberOf(filter.toBlock);
  const addresses =
    filter.address === undefined
      ? null
      : Array.isArray(filter.address)
        ? filter.address
        : [filter.address];
  return TRANSACTIONS.filter(
    (t) => t.blockNumber >= from && t.blockNumber <= to
  )
    .flatMap(rpcLogs)
    .filter(
      (log) =>
        (!addresses || addresses.some((a) => same(a, log.address))) &&
        (filter.topics ?? []).every((wanted, i) =>
          topicMatches(wanted, log.topics[i])
        )
    );
}

/** Alchemy's alchemy_getAssetTransfers over the cassette, one page. */
export function assetTransfers(params: {
  fromBlock?: string;
  toBlock?: string;
  fromAddress?: string;
  toAddress?: string;
  contractAddresses?: string[];
  category?: string[];
  excludeZeroValue?: boolean;
}) {
  const from = blockNumberOf(params.fromBlock ?? 'earliest');
  const to =
    params.toBlock === 'indexed'
      ? FINALIZED_BLOCK
      : blockNumberOf(params.toBlock);
  const categories = params.category ?? [];
  for (const category of categories)
    if (!['erc1155', 'erc721', 'external'].includes(category))
      throw new Error(`The cassette has no ${category} transfers`);
  const inRange = TRANSACTIONS.filter(
    (t) => t.blockNumber >= from && t.blockNumber <= to
  );
  const transfers = [];
  for (const t of inRange) {
    const metadata = {
      blockTimestamp: new Date(timestamp(t.blockNumber) * 1000).toISOString()
    };
    if (
      categories.includes('external') &&
      (!params.toAddress || same(params.toAddress, t.to)) &&
      (!params.fromAddress || same(params.fromAddress, t.from)) &&
      !(params.excludeZeroValue && t.value === BigInt(0))
    ) {
      transfers.push({
        blockNum: hex(t.blockNumber),
        uniqueId: `${t.hash}:external`,
        hash: t.hash,
        from: t.from,
        to: t.to,
        value: Number(t.value) / 1e18,
        erc721TokenId: null,
        erc1155Metadata: null,
        tokenId: null,
        asset: 'ETH',
        category: 'external',
        rawContract: { value: hex(t.value), address: null, decimal: '0x12' },
        metadata
      });
    }
    if (!categories.includes('erc1155')) continue;
    rpcLogs(t).forEach((log) => {
      const event = CREATOR.parseLog(log);
      if (
        event?.name !== 'TransferSingle' ||
        (params.contractAddresses &&
          !params.contractAddresses.some((c) => same(c, log.address))) ||
        (params.toAddress && !same(params.toAddress, event.args.to)) ||
        (params.fromAddress && !same(params.fromAddress, event.args.from))
      )
        return;
      transfers.push({
        blockNum: hex(t.blockNumber),
        uniqueId: `${t.hash}:log:${Number(log.logIndex)}`,
        hash: t.hash,
        from: String(event.args.from).toLowerCase(),
        to: String(event.args.to).toLowerCase(),
        value: null,
        erc721TokenId: null,
        erc1155Metadata: [
          { tokenId: hex(event.args.id), value: hex(event.args.value) }
        ],
        tokenId: hex(event.args.id),
        asset: null,
        category: 'erc1155',
        rawContract: {
          value: null,
          address: log.address.toLowerCase(),
          decimal: null
        },
        metadata
      });
    });
  }
  return { transfers };
}

type RpcAnswer =
  | { result: unknown }
  | { error: { code: number; message: string; data?: string } };

function answer(method: string, params: any[]): RpcAnswer | null {
  switch (method) {
    case 'eth_chainId':
      return { result: '0x1' };
    case 'net_version':
      return { result: '1' };
    case 'eth_blockNumber':
      return { result: hex(FINALIZED_BLOCK) };
    case 'eth_getBlockByNumber':
      return { result: block(blockNumberOf(params[0]), !!params[1]) };
    case 'eth_getBlockByHash': {
      const number = Array.from(
        { length: FINALIZED_BLOCK + 1 },
        (_, n) => n
      ).find((n) => blockHash(n) === params[0]);
      return {
        result: number === undefined ? null : block(number, !!params[1])
      };
    }
    case 'eth_getTransactionByHash': {
      const t = TRANSACTIONS.find((candidate) => candidate.hash === params[0]);
      return { result: t ? rpcTransaction(t) : null };
    }
    case 'eth_getTransactionReceipt': {
      const t = TRANSACTIONS.find((candidate) => candidate.hash === params[0]);
      return { result: t ? receipt(t) : null };
    }
    case 'eth_getLogs':
      return { result: logs(params[0]) };
    case 'trace_block':
      return { result: [] };
    case 'eth_call': {
      const call = CALLS.find(
        (c) => same(c.to, params[0]?.to) && same(c.data, params[0]?.data)
      );
      if (!call) return null;
      if (call.revert)
        return {
          error: {
            code: 3,
            message: `execution reverted: ${call.revert}`,
            data: revertData(call.revert)
          }
        };
      return { result: call.result };
    }
    default:
      return null;
  }
}

export interface RunningCassette {
  readonly url: string;
  /** Requests the cassette could not answer, as "method params". */
  readonly unanswered: string[];
  close(): Promise<void>;
}

/** Serves the cassette as a JSON-RPC node on a loopback port. */
export async function startCassetteNode(): Promise<RunningCassette> {
  const unanswered: string[] = [];
  const reply = (request: { id: unknown; method: string; params?: any[] }) => {
    let answered: RpcAnswer | null;
    try {
      answered = answer(request.method, request.params ?? []);
    } catch (error) {
      answered = null;
      unanswered.push(`${request.method} ${String(error)}`);
    }
    if (!answered) {
      unanswered.push(`${request.method} ${JSON.stringify(request.params)}`);
      answered = { error: { code: -32601, message: 'Not in the cassette' } };
    }
    return { jsonrpc: '2.0', id: request.id, ...answered };
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const response = Array.isArray(body) ? body.map(reply) : reply(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    unanswered,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
}

/** The metadata document a gateway URL names, by its Arweave id. */
export function metadataFor(url: string): unknown {
  const id = url.split('/').filter(Boolean).pop();
  const entry = Object.entries(METADATA).find(([uri]) =>
    uri.endsWith(`/${id}`)
  );
  return entry?.[1];
}
