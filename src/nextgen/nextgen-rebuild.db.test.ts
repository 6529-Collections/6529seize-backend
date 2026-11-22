import 'reflect-metadata';
import { TRANSACTIONS_TABLE } from '@/constants';
import { connect, disconnect, getDataSource } from '@/db';
import * as Entities from '@/entities/entities';
import {
  ADMIN,
  MARK_BLOCK,
  metadataFor,
  NEXTGEN_BASE_URI,
  NEXTGEN_CORE,
  NEXTGEN_TOKEN,
  RunningCassette,
  startCassetteNode,
  WALLET_1,
  WALLET_2
} from '@/holdings/ethereum-index.cassette';
import { findNextGenTransactions } from './nextgen';
import { processMissingThumbnails } from './nextgen_pending_thumbnails';
import {
  NEXTGEN_BLOCKS_TABLE,
  NEXTGEN_COLLECTIONS_TABLE,
  NEXTGEN_LOGS_TABLE,
  NEXTGEN_TOKEN_SCORES_TABLE,
  NEXTGEN_TOKEN_TRAITS_TABLE,
  NEXTGEN_TOKENS_TABLE
} from './nextgen_constants';
import { rebuildNextGen } from './nextgen-rebuild';

// Alchemy's transfer API and the trace endpoint answer from the cassette;
// the node calls go to the cassette's loopback server.
jest.mock('@/alchemy-sdk', () => {
  const cassette = jest.requireActual('@/holdings/ethereum-index.cassette');
  return {
    ...jest.requireActual('@/alchemy-sdk'),
    Alchemy: jest.fn().mockImplementation(() => ({
      core: {
        getAssetTransfers: async (params: unknown) =>
          cassette.assetTransfers(params)
      }
    }))
  };
});
jest.mock('@/ethereum-rpc/trace-provider', () => {
  const { JsonRpcProvider } = jest.requireActual('ethers');
  let provider: InstanceType<typeof JsonRpcProvider> | null = null;
  const trace = () =>
    (provider ??= new JsonRpcProvider(process.env.ETHEREUM_RPC_URL, 1));
  return { getAlchemyTraceProvider: trace, get6529TraceProvider: trace };
});
// Provider data outside the chain: ENS names in the log text, and the
// thumbnails the live loop lists from the media bucket.
jest.mock('@/ens-lookup', () => ({
  ...jest.requireActual('@/ens-lookup'),
  findEnsForAddress: jest.fn(async () => null)
}));
jest.mock('./nextgen_pending_thumbnails', () => ({
  processMissingThumbnails: jest.fn(async () => undefined)
}));

const NEXTGEN_TABLES: [string, string][] = [
  [NEXTGEN_COLLECTIONS_TABLE, 'id'],
  [NEXTGEN_LOGS_TABLE, 'block, id'],
  [NEXTGEN_TOKENS_TABLE, 'id'],
  [NEXTGEN_TOKEN_TRAITS_TABLE, 'token_id, trait'],
  [NEXTGEN_TOKEN_SCORES_TABLE, 'id'],
  [NEXTGEN_BLOCKS_TABLE, 'block']
];

async function emptyTables() {
  for (const [table] of NEXTGEN_TABLES) {
    await getDataSource().query(`DELETE FROM \`${table}\``);
  }
  await getDataSource().query(`DELETE FROM ${TRANSACTIONS_TABLE}`);
  await getDataSource().query(`DELETE FROM transfer_reconciliations`);
}

/** The NextGen tables and NextGen's rows of `transactions`, without write times. */
async function nextGenTables() {
  const state: Record<string, Record<string, unknown>[]> = {};
  const read = async (table: string, order: string, where = '') => {
    const rows: Record<string, unknown>[] = await getDataSource().query(
      `SELECT * FROM \`${table}\` ${where} ORDER BY ${order}`
    );
    state[table] = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([column]) => !['created_at', 'updated_at'].includes(column)
        )
      )
    );
  };
  for (const [table, order] of NEXTGEN_TABLES) await read(table, order);
  await read(
    TRANSACTIONS_TABLE,
    'block, transaction',
    `WHERE LOWER(contract) = '${NEXTGEN_CORE.toLowerCase()}'`
  );
  return state;
}

describe('NextGen rebuilt from empty', () => {
  const env = process.env;
  let cassette: RunningCassette;

  beforeAll(async () => {
    cassette = await startCassetteNode();
    process.env = {
      ...env,
      ETHEREUM_RPC_URL: cassette.url,
      ALCHEMY_API_KEY: 'cassette',
      NEXTGEN_START_BLOCK: '0'
    };
    const fetch = global.fetch;
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.includes('arweave.net')) return fetch(input, init);
        const data = metadataFor(url);
        return new Response(data ? JSON.stringify(data) : 'not found', {
          status: data ? 200 : 404,
          headers: { 'content-type': 'application/json' }
        });
      });
    await connect(
      Object.values(Entities).filter((e) => typeof e === 'function'),
      false
    );
  });

  afterAll(async () => {
    await emptyTables();
    await disconnect();
    await cassette.close();
    jest.restoreAllMocks();
    process.env = env;
  });

  it('writes what the live loop writes over the same blocks', async () => {
    await emptyTables();
    // The live loop, from an empty database, to the same block.
    await expect(
      findNextGenTransactions(undefined, { toBlock: MARK_BLOCK })
    ).resolves.toEqual({ caughtUp: true });
    const live = await nextGenTables();
    expect(processMissingThumbnails).toHaveBeenCalledTimes(1);

    await emptyTables();
    await rebuildNextGen({ mark: { ethBlock: MARK_BLOCK } });
    const rebuilt = await nextGenTables();

    expect(cassette.unanswered).toEqual([]);
    expect(rebuilt).toEqual(live);
    // The rebuild leaves the media bucket's thumbnails to the live loop.
    expect(processMissingThumbnails).toHaveBeenCalledTimes(1);

    // The rows say what the cassette's chain does.
    expect(rebuilt[NEXTGEN_COLLECTIONS_TABLE]).toEqual([
      expect.objectContaining({
        id: 1,
        name: 'Cassette Pebbles',
        base_uri: NEXTGEN_BASE_URI,
        artist_address: ADMIN.replace('a', 'A'),
        total_supply: 100,
        public_start: '1767225600'
      })
    ]);
    expect(
      rebuilt[NEXTGEN_TOKENS_TABLE].map((t) => [
        Number(t.id),
        t.name,
        t.owner,
        t.mint_price,
        t.mint_data
      ])
    ).toEqual([
      [
        NEXTGEN_TOKEN,
        `Cassette Pebble #${NEXTGEN_TOKEN}`,
        WALLET_2,
        0.0069,
        '{"Phase":"Public"}'
      ]
    ]);
    expect(
      rebuilt[NEXTGEN_TOKEN_TRAITS_TABLE].map((t) => [t.trait, t.value])
    ).toEqual([
      ['Mint Type - Phase', 'Public'],
      ['Palette', 'Blue'],
      ['Shape', 'Round']
    ]);
    expect(
      rebuilt[NEXTGEN_TOKEN_SCORES_TABLE].map((t) => [
        Number(t.id),
        t.rarity_score_rank,
        t.rarity_score_trait_count
      ])
    ).toEqual([[NEXTGEN_TOKEN, 1, 3]]);
    expect(
      rebuilt[NEXTGEN_LOGS_TABLE].map((l) => [Number(l.block), l.heading])
    ).toEqual([
      [104, 'Collection Created'],
      [105, 'Collection Data Set'],
      [106, 'Collection Phases Set'],
      [107, 'Mint of Cassette Pebbles #0 for 0.0069 ETH'],
      [108, 'Transfer of Cassette Pebbles #0']
    ]);
    expect(
      rebuilt[TRANSACTIONS_TABLE].map((t) => [
        Number(t.block),
        t.from_address,
        t.to_address,
        t.value
      ])
    ).toEqual([
      [107, '0x0000000000000000000000000000000000000000', WALLET_1, 0.0069],
      [108, WALLET_1, WALLET_2, 0]
    ]);
    expect(rebuilt[NEXTGEN_BLOCKS_TABLE].map((b) => Number(b.block))).toEqual([
      MARK_BLOCK
    ]);
  }, 300_000);
});
