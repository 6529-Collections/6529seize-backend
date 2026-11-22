import { appFeatures } from '@/app-features';
import {
  fetchAllConsolidatedTdh,
  fetchAllTDH,
  persistConsolidatedTDH,
  persistTDH
} from '@/db';
import {
  ConsolidatedTDH,
  ConsolidatedTDHMemes,
  TDH,
  TDHMemes
} from '@/entities/ITDH';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { Logger } from '@/logging';
import { fetchNextgenTokens } from '@/nextgen/nextgen.db';
import * as priorityAlertsContext from '@/priority-alerts.context';
import { findNftTDH } from '@/tdhLoop/nft_tdh';
import {
  calculateRanks,
  getAdjustedMemesAndSeasons,
  updateTDH
} from '@/tdhLoop/tdh';
import { consolidateTDHInMemory } from '@/tdhLoop/tdh_consolidation';
import { calculateTdhEditions, TDHEditionsRow } from '@/tdhLoop/tdh_editions';
import { calculateMemesTdh } from '@/tdhLoop/tdh_memes';
import { calculateNftTDH } from '@/tdhLoop/tdh_nft';
import { uploadTDH } from '@/tdhLoop/tdh_upload';
import { recordTdhMetrics } from '@/tdhLoop/tdh-metrics';
import { applyChainTokenValues } from './apply-chain-values';
import {
  ChainTdhIngestDeps,
  ChainTdhRows,
  ingestChainDay
} from './chain-tdh-ingest';
import { RateLimitedFetcher } from './rate-limited-fetcher';
import { tdhChainDaysDb } from './tdh-chain-days.db';
import { PollerDeps } from './tdh-chain-day-poller';
import { GatewayTdhChainSource } from './tdh-chain-source';

/**
 * The ingest and poller wired to the site: its Ethereum RPC, the TDH loop's
 * computation, the TDH tables and tdh_chain_days. Kept apart from the logic
 * so the logic is tested without a database.
 */

const logger = Logger.get('TDH_CHAIN_INGEST');

async function writeChainTdh(rows: ChainTdhRows): Promise<void> {
  const { day, blockTimestamp, adjustedSeasons, wallets, consolidated } = rows;
  const block = day.header.cutoffNumber;
  await persistTDH(
    block,
    wallets.tdh,
    wallets.memesTdh as TDHMemes[],
    wallets.tdhEditions as TDHEditionsRow[]
  );
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
    blockTimestamp
  );
  await findNftTDH();
  await recordTdhMetrics();
  await uploadTDH(block, blockTimestamp, wallets.tdh, false, true);
  await uploadTDH(block, blockTimestamp, consolidated, true, true);
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

export function siteIngestDeps(block: () => number): ChainTdhIngestDeps {
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
    async readLive() {
      return {
        wallets: (await fetchAllTDH(block())) as TDH[],
        consolidated: await fetchAllConsolidatedTdh()
      };
    },
    write: writeChainTdh,
    keyWidth: () => tdhChainDaysDb.consolidationKeyWidth(),
    saveDay: (s) => tdhChainDaysDb.save(s),
    now: () => Date.now()
  };
}

/** The poller with the gateway named by TDH_CHAIN_GATEWAY_URL. */
export function sitePollerDeps(): PollerDeps {
  const mode = appFeatures.isTdhFromChainEnabled()
    ? 'CHAIN'
    : appFeatures.isTdhChainShadowEnabled()
      ? 'SHADOW'
      : null;
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
  let currentBlock = 0;
  const ingestDeps = siteIngestDeps(() => currentBlock);
  return {
    mode,
    source: new GatewayTdhChainSource(gateway, fetcher),
    latestRow: () => tdhChainDaysDb.latest(),
    keyWidth: () => tdhChainDaysDb.consolidationKeyWidth(),
    ingest(day, m) {
      currentBlock = day.header.cutoffNumber;
      return ingestChainDay(day, m, ingestDeps);
    },
    alert: (title, message) =>
      priorityAlertsContext.sendPriorityAlert(title, new Error(message))
  };
}
