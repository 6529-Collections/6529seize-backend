import 'reflect-metadata';
import axios from 'axios';
import {
  AGGREGATED_ACTIVITY_MEMES_TABLE,
  AGGREGATED_ACTIVITY_TABLE,
  ARTISTS_TABLE,
  CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE,
  CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_TABLE,
  GRADIENT_CONTRACT,
  LAB_EXTENDED_DATA_TABLE,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  MEMES_EXTENDED_DATA_TABLE,
  MEMES_SEASONS_TABLE,
  NFT_OWNERS_CONSOLIDATION_TABLE,
  NULL_ADDRESS,
  NFT_OWNERS_TABLE,
  NFTS_HISTORY_BLOCKS_TABLE,
  NFTS_HISTORY_CLAIMS_TABLE,
  NFTS_HISTORY_EVENTS_TABLE,
  NFTS_HISTORY_TABLE,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE,
  OWNERS_BALANCES_MEMES_TABLE,
  OWNERS_BALANCES_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { connect, disconnect, getDataSource } from '@/db';
import { discoverEns } from '@/ens';
import * as Entities from '@/entities/entities';
import { insertMemesMintStatsIfMissing } from '@/memes-mint-stats/memes-mint-stats';
import { updateAggregatedActivity } from '@/aggregatedActivityLoop/aggregated_activity';
import { findNFTHistory } from '@/nft_history';
import { rebuildNftHistoryStep } from '@/nft-history/history-rebuild';
import { updateNftOwners } from '@/nftOwnersLoop/nft_owners';
import {
  findMemeLabExtendedData,
  findMemesExtendedData
} from '@/nftsLoop/nft-extended-data';
import { NFT_MODE, processNFTs } from '@/nftsLoop/nfts';
import { updateOwnerBalances } from '@/ownersBalancesLoop/owners_balances';
import { transactionsDiscoveryService } from '@/transactions/transactions-discovery.service';
import {
  MARK_BLOCK,
  metadataFor,
  RunningCassette,
  startCassetteNode,
  WALLET_1,
  WALLET_2
} from './ethereum-index.cassette';
import {
  rebuildHoldingsBalances,
  rebuildNftCatalogue,
  rebuildNftOwners,
  rebuildTransactions
} from './ethereum-index-rebuild';

// Alchemy's transfer API and the trace endpoint answer from the cassette;
// the node calls go to the cassette's loopback server.
jest.mock('@/alchemy', () => {
  const cassette = jest.requireActual('./ethereum-index.cassette');
  const alchemy = {
    core: {
      getAssetTransfers: async (params: unknown) =>
        cassette.assetTransfers(params)
    }
  };
  return { getAlchemyInstance: () => alchemy };
});
jest.mock('@/alchemy-sdk', () => {
  const cassette = jest.requireActual('./ethereum-index.cassette');
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
  return {
    getAlchemyTraceProvider: trace,
    get6529TraceProvider: trace
  };
});
// Effects outside the index tables, which the comparison leaves out.
jest.mock('@/ens', () => ({
  ...jest.requireActual('@/ens'),
  discoverEns: jest.fn(async () => undefined)
}));
// Mint stats write through a TypeORM transaction the test's SQL executor
// can't drive; the live pass must still ask for them.
jest.mock('@/memes-mint-stats/memes-mint-stats', () => ({
  ...jest.requireActual('@/memes-mint-stats/memes-mint-stats'),
  insertMemesMintStatsIfMissing: jest.fn(async () => null)
}));
jest.mock('@/deployer-dropper', () => ({
  deployerDropper: { drop: jest.fn() }
}));
jest.mock('@/subscriptionsDaily/subscription-quantity-sync.db', () => ({
  synchronizeAutomaticSubscriptionQuantities: jest.fn(async () => []),
  synchronizeAutomaticSubscriptionQuantitiesAfterReset: jest.fn(
    async () => undefined
  )
}));
jest.mock('@/subscriptionsDaily/subscription-cache', () => ({
  invalidateUpcomingSubscriptionCaches: jest.fn(async () => undefined),
  retryPendingSubscriptionCacheInvalidations: jest.fn(async () => undefined)
}));
jest.mock('@/subscription-coverage/subscription-coverage-dirty', () => ({
  markSubscriptionCoverageDirtyForDemonstratedIntent: jest.fn(
    async () => undefined
  )
}));

/** The index tables the steps fill, each with an order for comparison. */
const INDEX_TABLES: [string, string][] = [
  [TRANSACTIONS_TABLE, 'transaction, from_address, to_address, token_id'],
  [NFT_OWNERS_TABLE, 'wallet, contract, token_id'],
  [NFT_OWNERS_CONSOLIDATION_TABLE, 'consolidation_key, contract, token_id'],
  [NFTS_TABLE, 'contract, id'],
  [NFTS_MEME_LAB_TABLE, 'contract, id'],
  [MEMES_EXTENDED_DATA_TABLE, 'id'],
  [LAB_EXTENDED_DATA_TABLE, 'id'],
  [MEMES_SEASONS_TABLE, 'id'],
  [ARTISTS_TABLE, 'name'],
  [NFTS_HISTORY_TABLE, 'contract, nft_id, block, transaction_hash'],
  [NFTS_HISTORY_EVENTS_TABLE, 'event_id'],
  [NFTS_HISTORY_CLAIMS_TABLE, 'claimIndex'],
  [OWNERS_BALANCES_TABLE, 'wallet'],
  [OWNERS_BALANCES_MEMES_TABLE, 'wallet, season'],
  [CONSOLIDATED_OWNERS_BALANCES_TABLE, 'consolidation_key'],
  [CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE, 'consolidation_key, season'],
  [AGGREGATED_ACTIVITY_TABLE, 'wallet'],
  [AGGREGATED_ACTIVITY_MEMES_TABLE, 'wallet, season'],
  [CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE, 'consolidation_key'],
  [CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE, 'consolidation_key, season']
];
/** Tables the loops also write, emptied before each pass. */
const ALSO_WRITTEN = [
  NFTS_HISTORY_BLOCKS_TABLE,
  'nft_owners_sync_state',
  'transfer_reconciliations',
  'memes_mint_stats',
  's3_uploader_outbox'
];
// Written at run time, so they differ between any two passes.
const isRunTime = (column: string) =>
  column.endsWith('_at') || column === 'block_reference';

async function emptyTables() {
  for (const table of [...INDEX_TABLES.map(([t]) => t), ...ALSO_WRITTEN]) {
    await getDataSource().query(`DELETE FROM \`${table}\``);
  }
}

/**
 * The index tables' rows, without write times, and the history checkpoint.
 * The live loop checkpoints every 20 blocks on the way and the rebuild only
 * at its source blocks, so only where each ends is compared.
 */
async function indexTables() {
  const [{ checkpoint }] = await getDataSource().query(
    `SELECT MAX(block) AS checkpoint FROM \`${NFTS_HISTORY_BLOCKS_TABLE}\``
  );
  const state: Record<string, Record<string, unknown>[]> = {
    checkpoint: [{ block: Number(checkpoint) }]
  };
  for (const [table, order] of INDEX_TABLES) {
    const rows: Record<string, unknown>[] = await getDataSource().query(
      `SELECT * FROM \`${table}\` ORDER BY ${order}`
    );
    state[table] = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([column]) => !isRunTime(column))
      )
    );
  }
  return state;
}

/** What each live loop runs, in the rebuild's order, up to the same block. */
async function runLiveLoops() {
  for (const contract of [
    MEMES_CONTRACT,
    GRADIENT_CONTRACT,
    MEMELAB_CONTRACT
  ]) {
    await transactionsDiscoveryService.getAndSaveTransactionsForContract(
      contract,
      null,
      MARK_BLOCK
    );
  }
  await updateNftOwners();
  await processNFTs(NFT_MODE.DISCOVER);
  await processNFTs(NFT_MODE.REFRESH);
  await findMemesExtendedData();
  await findMemeLabExtendedData();
  await findNFTHistory(false, undefined, MARK_BLOCK);
  await updateAggregatedActivity();
  await updateOwnerBalances();
}

async function runRebuild() {
  const ctx = { mark: { ethBlock: MARK_BLOCK } };
  await rebuildTransactions(ctx);
  await rebuildNftOwners();
  await rebuildNftCatalogue();
  await rebuildNftHistoryStep(ctx);
  await rebuildHoldingsBalances();
}

describe('the Ethereum index rebuild from empty', () => {
  const env = process.env;
  let cassette: RunningCassette;

  beforeAll(async () => {
    cassette = await startCassetteNode();
    process.env = {
      ...env,
      ETHEREUM_RPC_URL: cassette.url,
      ALCHEMY_API_KEY: 'cassette'
    };
    jest.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      const data = metadataFor(url);
      if (!data) throw new Error(`No metadata in the cassette for ${url}`);
      return { data, headers: { 'content-type': 'application/json' } };
    });
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

  it('writes what the live loops write over the same blocks', async () => {
    await emptyTables();
    await runLiveLoops();
    const live = await indexTables();
    expect(discoverEns).toHaveBeenCalled();
    expect(insertMemesMintStatsIfMissing).toHaveBeenCalledWith(
      1,
      expect.any(Date)
    );

    jest.mocked(discoverEns).mockClear();
    jest.mocked(insertMemesMintStatsIfMissing).mockClear();
    await emptyTables();
    await runRebuild();
    const rebuilt = await indexTables();

    expect(cassette.unanswered).toEqual([]);
    expect(rebuilt).toEqual(live);
    // The rebuild leaves ENS names and mint stats to their own refills.
    expect(discoverEns).not.toHaveBeenCalled();
    expect(insertMemesMintStatsIfMissing).not.toHaveBeenCalled();

    // The rows say what the cassette's chain does.
    expect(
      rebuilt[TRANSACTIONS_TABLE].map((t) => [
        Number(t.block),
        t.from_address,
        t.to_address,
        Number(t.token_id),
        Number(t.token_count)
      ]).sort(
        (a, b) =>
          (a[0] as number) - (b[0] as number) ||
          (a[3] as number) - (b[3] as number)
      )
    ).toEqual([
      [101, NULL_ADDRESS, WALLET_1, 1, 2],
      [101, NULL_ADDRESS, WALLET_1, 2, 1],
      [101, NULL_ADDRESS, WALLET_1, 3, 1],
      [102, WALLET_1, WALLET_2, 1, 1]
    ]);
    expect(
      rebuilt[NFT_OWNERS_TABLE].map((o) => [
        o.wallet,
        Number(o.token_id),
        Number(o.balance)
      ])
    ).toEqual([
      [WALLET_1, 1, 1],
      [WALLET_1, 2, 1],
      [WALLET_1, 3, 1],
      [WALLET_2, 1, 1]
    ]);
    // Card 1 with its second token URI's metadata.
    expect(
      rebuilt[NFTS_TABLE].map((n) => [n.id, n.name, Number(n.supply)])
    ).toEqual([
      [1, 'Cassette Card 1', 2],
      [2, 'Cassette Card 2', 1],
      [3, 'Cassette Card 3', 1]
    ]);
    expect(rebuilt.checkpoint).toEqual([{ block: MARK_BLOCK }]);
    // Each card's first token URI, then card 1's change at block 103.
    expect(
      rebuilt[NFTS_HISTORY_TABLE].map((h) => [
        Number(h.nft_id),
        Number(h.block),
        JSON.parse(String(h.description)).event
      ])
    ).toEqual([
      [1, 101, 'Initialized'],
      [2, 101, 'Initialized'],
      [3, 101, 'Initialized']
    ]);
    expect(
      rebuilt[NFTS_HISTORY_EVENTS_TABLE].map((e) => [
        Number(e.nft_id),
        Number(e.block),
        JSON.parse(String(e.description)).changes.map(
          (c: { key: string }) => c.key
        )
      ])
    ).toEqual([[1, 103, ['description', 'image']]]);
    expect(
      rebuilt[ARTISTS_TABLE].map((a) => [
        a.name,
        JSON.parse(String(a.memes)).map((m: { id: number }) => m.id)
      ])
    ).toEqual([['Cassette Artist', [1, 2, 3]]]);
    expect(
      rebuilt[MEMES_SEASONS_TABLE].map((m) => [m.id, m.start_index, m.count])
    ).toEqual([[1, 1, 3]]);
    expect(
      rebuilt[CONSOLIDATED_OWNERS_BALANCES_TABLE].filter(
        (b) => b.consolidation_key !== NULL_ADDRESS
      ).map((b) => [b.consolidation_key, b.memes_balance, b.memes_cards_sets])
    ).toEqual([
      [WALLET_1, 3, 1],
      [WALLET_2, 1, 0]
    ]);
  }, 600_000);
});
