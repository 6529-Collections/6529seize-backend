import { appFeatures } from '@/app-features';
import {
  fetchAllConsolidatedTdh,
  fetchAllTDH,
  fetchMaxTransactionsBlockNumber,
  persistConsolidatedTDH
} from '@/db';
import {
  ConsolidatedTDH,
  ConsolidatedTDHMemes,
  TDH,
  TDHEditions,
  TDHMemes
} from '@/entities/ITDH';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { Logger } from '@/logging';
import { fetchNextgenTokens } from '@/nextgen/nextgen.db';
import * as priorityAlertsContext from '@/priority-alerts.context';
import { hasTdhHistoryInputs, runTdhHistoryForDate } from '@/tdhHistoryLoop';
import { findNftTDH } from '@/tdhLoop/nft_tdh';
import {
  calculateRanks,
  getAdjustedMemesAndSeasons,
  updateTDH
} from '@/tdhLoop/tdh';
import { consolidateTDHInMemory } from '@/tdhLoop/tdh_consolidation';
import { calculateTdhEditions } from '@/tdhLoop/tdh_editions';
import { calculateMemesTdh } from '@/tdhLoop/tdh_memes';
import { calculateNftTDH } from '@/tdhLoop/tdh_nft';
import { uploadTDH } from '@/tdhLoop/tdh_upload';
import { recordTdhMetrics } from '@/tdhLoop/tdh-metrics';
import { applyChainTokenValues } from './apply-chain-values';
import {
  ChainDayStepRunner,
  ChainTdhIngestDeps,
  ChainTdhRows,
  ingestChainDay
} from './chain-tdh-ingest';
import { RateLimitedFetcher } from './rate-limited-fetcher';
import { dateOfCycleDay } from './site-day';
import {
  ChainDayStep,
  SaveTdhChainDay,
  tdhChainDaysDb
} from './tdh-chain-days.db';
import { PollerDeps } from './tdh-chain-day-poller';
import {
  GatewayTdhChainSource,
  readChainDay,
  TdhChainSource
} from './tdh-chain-source';
import { formatTokenDayFile, formatWalletDayFile } from './tdh-day-file';
import { verifyChainDay } from './chain-day-verify';
import { uploadTdhCsvToArweave } from '@/tdhLoop/tdh-arweave-upload';
import { JWKInterface } from 'arweave/node/lib/wallet';
import { createHash } from 'crypto';

/**
 * The ingest and poller wired to the site: its Ethereum RPC, the TDH loop's
 * computation, the TDH tables and tdh_chain_days. Kept apart from the logic,
 * which is tested without a database.
 */

const logger = Logger.get('TDH_CHAIN_INGEST');

/** The day's TDH tables and its record, in one transaction. */
async function writeDay(
  rows: ChainTdhRows,
  record: SaveTdhChainDay
): Promise<void> {
  const { day, blockTimestamp, adjustedSeasons, wallets, consolidated } = rows;
  const block = day.header.cutoffNumber;
  const memes = (await calculateMemesTdh(
    adjustedSeasons,
    consolidated,
    true
  )) as ConsolidatedTDHMemes[];
  const editions = await calculateTdhEditions(consolidated, true);
  const nft = calculateNftTDH(consolidated);
  const tokenOverrides = applyChainTokenValues(day, nft);
  if (tokenOverrides.length) {
    logger.warn(
      `[PER-CARD VALUES TAKEN FROM THE CHAIN] [${tokenOverrides.length}]`
    );
  }
  await persistConsolidatedTDH(
    block,
    consolidated,
    memes,
    editions,
    nft,
    { mode: 'FULL' },
    blockTimestamp,
    {},
    {
      walletTdh: {
        tdh: wallets.tdh,
        memesTdh: wallets.memesTdh as TDHMemes[],
        tdhEditions: wallets.tdhEditions as TDHEditions[]
      },
      afterWrite: (connection) => tdhChainDaysDb.save(record, connection)
    }
  );
}

/**
 * The follow-up steps, each reading what the write committed, so a resumed
 * run needs nothing kept in memory:
 * - nfts: per-NFT totals and NextGen token TDH from the consolidated rows;
 * - history: days N-1 (when the day before it is present) and N, from
 *   historic_tdh_consolidation only;
 * - metrics: as a full tdhLoop run records them;
 * - uploads: the two dated CSV files, each skipped if already listed;
 * - dayFiles: the chain's day as two day files (`tdh-day-file.ts`), read
 *   again from the gateway and checked, published to Arweave, their URLs
 *   and sha256 kept on the day's record; skipped once published.
 */
export function siteStepRunner(
  blockOf: (cycleDay: number) => number,
  source: TdhChainSource
): ChainDayStepRunner {
  async function run(step: ChainDayStep, cycleDay: number) {
    const block = blockOf(cycleDay);
    const blockTimestamp = new Date(cycleDay * 86_400_000 - 1000);
    switch (step) {
      case 'nfts':
        await findNftTDH();
        return;
      case 'history':
        for (const d of [cycleDay - 1, cycleDay]) {
          const date = new Date(d * 86_400_000);
          if (!(await hasTdhHistoryInputs(date))) {
            logger.warn(
              `[NO HISTORY FOR DAY ${d}] [THE DAY BEFORE IT IS MISSING]`
            );
            continue;
          }
          await runTdhHistoryForDate(date, { fallback: false });
        }
        return;
      case 'metrics':
        await recordTdhMetrics();
        return;
      case 'uploads': {
        const date = dateOfCycleDay(cycleDay);
        if (!(await tdhChainDaysDb.uploadExists(false, date, block))) {
          const wallets = (await fetchAllTDH(block)) as TDH[];
          await uploadTDH(block, blockTimestamp, wallets, false, true);
        }
        if (!(await tdhChainDaysDb.uploadExists(true, date, block))) {
          const consolidated = (await fetchAllConsolidatedTdh()).filter(
            (row) => Number(row.block) === block
          );
          await uploadTDH(block, blockTimestamp, consolidated, true, true);
        }
        return;
      }
      case 'dayFiles':
        await publishDayFiles(cycleDay, source);
        return;
    }
  }
  return {
    run,
    markDone: (cycleDay, step) =>
      tdhChainDaysDb.markStepDone(cycleDay, step, Date.now())
  };
}

function arweaveKey(): JWKInterface {
  if (!process.env.ARWEAVE_KEY) throw new Error('ARWEAVE_KEY not set');
  try {
    return JSON.parse(process.env.ARWEAVE_KEY);
  } catch {
    // JSON parser diagnostics can include fragments of the private key.
    throw new Error('ARWEAVE_KEY invalid JSON');
  }
}

async function publishDayFiles(
  cycleDay: number,
  source: TdhChainSource
): Promise<void> {
  if (await tdhChainDaysDb.dayFilesPublished(cycleDay)) return;
  const day = await readChainDay(source, cycleDay);
  if (!day) throw new Error(`the gateway no longer serves day ${cycleDay}`);
  if (!verifyChainDay(day).ok) {
    throw new Error(`day ${cycleDay} from the gateway failed its checks`);
  }
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const key = arweaveKey();
  const walletsFile = formatWalletDayFile(day);
  const wallets = await uploadTdhCsvToArweave(walletsFile, key, logger);
  let tokensUrl: string | null = null;
  let tokensSha256: string | null = null;
  if (day.tokenLeaves) {
    const tokensFile = formatTokenDayFile(day);
    tokensUrl = (await uploadTdhCsvToArweave(tokensFile, key, logger)).url;
    tokensSha256 = sha(tokensFile);
  }
  await tdhChainDaysDb.saveDayFiles(cycleDay, {
    walletsUrl: wallets.url,
    walletsSha256: sha(walletsFile),
    tokensUrl,
    tokensSha256
  });
}

async function rerank(
  walletRows: TDH[],
  consolidatedRows: ConsolidatedTDH[],
  blockTimestamp: Date
) {
  const nextgen = await fetchNextgenTokens();
  const { ADJUSTED_NFTS } = await getAdjustedMemesAndSeasons(blockTimestamp);
  const wallets = await calculateRanks(
    walletRows.flatMap((t) => t.gradients ?? []),
    walletRows.flatMap((t) => t.nextgen ?? []),
    walletRows,
    ADJUSTED_NFTS,
    nextgen
  );
  const consolidated = await calculateRanks(
    consolidatedRows.flatMap((t) => t.gradients ?? []),
    consolidatedRows.flatMap((t) => t.nextgen ?? []),
    consolidatedRows,
    ADJUSTED_NFTS,
    nextgen
  );
  return { wallets, consolidated };
}

export function siteIngestDeps(steps: ChainDayStepRunner): ChainTdhIngestDeps {
  const rpc = getEthereumRpcClient();
  return {
    ethBlocks: {
      async getBlock(n: number) {
        const b = await rpc.getBlock(n);
        return { hash: (b.hash ?? '').toLowerCase(), timestamp: b.timestamp };
      }
    },
    async computeWallets(blockNumber, blockTimestamp, clusters) {
      const r = await updateTDH(blockTimestamp, undefined, {
        block: { number: blockNumber, timestamp: blockTimestamp },
        clusters,
        persist: false
      });
      return { tdh: r.tdh, memesTdh: r.memesTdh, tdhEditions: r.tdhEditions };
    },
    consolidate: consolidateTDHInMemory,
    rerank,
    async readLive(block) {
      return {
        wallets: (await fetchAllTDH(block)) as TDH[],
        consolidated: await fetchAllConsolidatedTdh()
      };
    },
    writeDay,
    steps,
    keyWidth: () => tdhChainDaysDb.consolidationKeyWidth(),
    latestTdhBlock: () => tdhChainDaysDb.latestTdhBlock(),
    transactionsIndexedTo: () => fetchMaxTransactionsBlockNumber(),
    saveDay: (s) => tdhChainDaysDb.save(s),
    now: () => Date.now()
  };
}

/** The mode the flags set now; the caller reads the flags again first. */
function tdhChainMode(): 'CHAIN' | 'SHADOW' | null {
  if (appFeatures.isTdhFromChainEnabled()) return 'CHAIN';
  if (appFeatures.isTdhChainShadowEnabled()) return 'SHADOW';
  return null;
}

/** The poller with the gateway named by TDH_CHAIN_GATEWAY_URL. */
export function sitePollerDeps(): PollerDeps {
  const mode = tdhChainMode();
  const gateway = process.env.TDH_CHAIN_GATEWAY_URL ?? '';
  if (mode && !gateway) {
    throw new Error('TDH_CHAIN_GATEWAY_URL is not set');
  }
  const host = gateway ? new URL(gateway).hostname.toLowerCase() : 'unset';
  const fetcher = new RateLimitedFetcher({
    allowedHosts: [host],
    minIntervalMs: 100,
    userAgent: '6529io-tdh-chain/1'
  });
  const blocks = new Map<number, number>();
  const source = new GatewayTdhChainSource(gateway, fetcher);
  const steps = siteStepRunner((cycleDay) => {
    const block = blocks.get(cycleDay);
    if (block === undefined) {
      throw new Error(`no block known for day ${cycleDay}`);
    }
    return block;
  }, source);
  const ingestDeps = siteIngestDeps(steps);
  return {
    mode,
    source,
    async latestRow() {
      const row = await tdhChainDaysDb.latest();
      if (row) blocks.set(row.cycleDay, row.block);
      return row;
    },
    latestWritten: () => tdhChainDaysDb.latestWritten(),
    keyWidth: () => tdhChainDaysDb.consolidationKeyWidth(),
    ingest(day, m) {
      blocks.set(day.header.cycleDay, day.header.cutoffNumber);
      return ingestChainDay(day, m, ingestDeps);
    },
    steps,
    alert: (title, message) =>
      priorityAlertsContext.sendPriorityAlert(title, new Error(message)),
    now: () => Date.now()
  };
}
