import { ConsolidatedTDH, TDH } from '@/entities/ITDH';
import { MemesSeason } from '@/entities/ISeason';
import { TdhClusterSource } from '@/tdhLoop/tdh-cluster-source';
import { applyChainValues, ChainOverride } from './apply-chain-values';
import { chainClusterSource } from './chain-cluster-source';
import {
  compareChainDay,
  CompareReport,
  DIFF_CLASSES
} from './chain-day-compare';
import {
  ChainDayFailure,
  EthBlockReader,
  verifyChainDay,
  verifyCutoff
} from './chain-day-verify';
import { dateOfCycleDay } from './site-day';
import { siteDayFromRows } from './site-day-rows';
import {
  SaveTdhChainDay,
  splitByKeyWidth,
  TdhChainDayMode,
  TdhChainDayStatus
} from './tdh-chain-days.db';
import { TdhChainDay } from './tdh-chain.types';

/**
 * One TDH day from the 6529 chain into 6529.io:
 *
 * 1. Verify the day (order, counts, roots, clusters, totals) and its cutoff
 *    block against Ethereum. A failed check records the day as FAILED and
 *    writes nothing else.
 * 2. Compute the site's own TDH at the chain's cutoff block, grouped by the
 *    chain's clusters, in memory: the breakdowns (base, raw, boost, seasons,
 *    editions) the chain doesn't carry.
 * 3. Compare that computation with the leaves, exactly, and keep the report.
 * 4. Write the chain's values over it (`applyChainValues`) and rank again
 *    on them.
 * 5. SHADOW: compare the chain's day with the live tables too, and diff the
 *    rows the switch would write against them. Write only tdh_chain_days.
 *    CHAIN: leave out any consolidation whose key is wider than the columns
 *    (queued on the day's row), then write the TDH tables as a full tdhLoop
 *    run does. The identities sync and "TDH calculations done" follow from
 *    that write as they do today.
 */

export interface ComputedWallets {
  readonly tdh: TDH[];
  readonly memesTdh: unknown[];
  readonly tdhEditions: unknown[];
}

export interface ChainTdhRows {
  readonly day: TdhChainDay;
  readonly blockTimestamp: Date;
  readonly adjustedSeasons: MemesSeason[];
  readonly wallets: ComputedWallets;
  readonly consolidated: ConsolidatedTDH[];
}

export interface LiveTdh {
  readonly wallets: TDH[];
  readonly consolidated: ConsolidatedTDH[];
}

export interface ChainTdhIngestDeps {
  readonly ethBlocks: EthBlockReader;
  computeWallets(
    block: number,
    blockTimestamp: Date,
    clusters: TdhClusterSource
  ): Promise<ComputedWallets>;
  consolidate(
    walletRows: TDH[],
    blockTimestamp: Date,
    clusters: TdhClusterSource
  ): Promise<{
    adjustedSeasons: MemesSeason[];
    consolidatedTdh: ConsolidatedTDH[];
  }>;
  rerank(
    walletRows: TDH[],
    consolidatedRows: ConsolidatedTDH[],
    blockTimestamp: Date
  ): Promise<{ wallets: TDH[]; consolidated: ConsolidatedTDH[] }>;
  readLive(): Promise<LiveTdh>;
  write(rows: ChainTdhRows): Promise<void>;
  keyWidth(): Promise<number>;
  saveDay(s: SaveTdhChainDay): Promise<void>;
  now(): number;
}

export interface ChainTdhIngestResult {
  readonly status: TdhChainDayStatus;
  readonly verdict: 'MATCH' | 'MISMATCH' | null;
  readonly deferredKeys: readonly string[];
  readonly summary: IngestSummary;
}

export interface IngestSummary {
  readonly mode: TdhChainDayMode;
  readonly cycleDay: number;
  readonly failures: readonly ChainDayFailure[];
  readonly cache?: ReportDigest;
  readonly live?: ReportDigest;
  readonly rowDiff?: RowDiff;
  readonly overrides?: {
    readonly count: number;
    readonly byKind: Record<string, number>;
    readonly examples: readonly ChainOverride[];
  };
  readonly added?: { readonly wallets: number; readonly identities: number };
  readonly deferredKeys?: number;
}

interface ReportDigest {
  readonly verdict: 'MATCH' | 'MISMATCH';
  readonly siteBlock: number;
  readonly counts: Record<string, number>;
  readonly walletRootFromSite: string;
  readonly notes: readonly string[];
}

function digest(r: CompareReport): ReportDigest {
  const counts: Record<string, number> = {};
  for (const c of DIFF_CLASSES) if (r.counts[c] > 0) counts[c] = r.counts[c];
  return {
    verdict: r.verdict,
    siteBlock: r.site.block,
    counts,
    walletRootFromSite: r.site.walletRootFromSite,
    notes: r.notes
  };
}

const DIFF_FIELDS = [
  'boosted_tdh',
  'tdh',
  'tdh__raw',
  'boost',
  'balance',
  'tdh_rank',
  'tdh_rank_memes',
  'tdh_rank_gradients',
  'tdh_rank_nextgen',
  'boosted_memes_tdh',
  'boosted_gradients_tdh',
  'boosted_nextgen_tdh'
] as const;

export interface RowDiff {
  readonly wallets: TableDiff;
  readonly identities: TableDiff;
}

interface TableDiff {
  readonly onlyComputed: number;
  readonly onlyLive: number;
  readonly byField: Record<string, number>;
  readonly examples: readonly {
    key: string;
    field: string;
    computed: unknown;
    live: unknown;
  }[];
}

function diffTable<T>(
  computed: readonly T[],
  live: readonly T[],
  keyOf: (row: T) => string
): TableDiff {
  const liveByKey = new Map<string, T>();
  live.forEach((r) => liveByKey.set(keyOf(r), r));
  const seen = new Set<string>();
  const byField: Record<string, number> = {};
  const examples: TableDiff['examples'][number][] = [];
  let onlyComputed = 0;
  for (const row of computed) {
    const key = keyOf(row);
    seen.add(key);
    const other = liveByKey.get(key);
    if (!other) {
      onlyComputed++;
      continue;
    }
    for (const f of DIFF_FIELDS) {
      const a = Number((row as any)[f]);
      const b = Number((other as any)[f]);
      if (a !== b) {
        byField[f] = (byField[f] ?? 0) + 1;
        if (examples.length < 20) {
          examples.push({ key, field: f, computed: a, live: b });
        }
      }
    }
  }
  const onlyLive = live.filter((r) => !seen.has(keyOf(r))).length;
  return { onlyComputed, onlyLive, byField, examples };
}

function overrideDigest(overrides: readonly ChainOverride[]) {
  const byKind: Record<string, number> = {};
  overrides.forEach((o) => (byKind[o.kind] = (byKind[o.kind] ?? 0) + 1));
  return { count: overrides.length, byKind, examples: overrides.slice(0, 20) };
}

export async function ingestChainDay(
  day: TdhChainDay,
  mode: TdhChainDayMode,
  deps: ChainTdhIngestDeps
): Promise<ChainTdhIngestResult> {
  const h = day.header;
  const verification = verifyChainDay(day);
  const failures: ChainDayFailure[] = [...verification.failures];
  if (verification.ok) {
    failures.push(...(await verifyCutoff(h, deps.ethBlocks)));
  }
  if (failures.length > 0) {
    const summary: IngestSummary = { mode, cycleDay: h.cycleDay, failures };
    await deps.saveDay({
      day,
      mode,
      status: 'FAILED',
      verdict: null,
      summary,
      deferredKeys: [],
      now: deps.now()
    });
    return { status: 'FAILED', verdict: null, deferredKeys: [], summary };
  }

  const clusters = chainClusterSource(verification.clusters);
  const blockTimestamp = new Date(h.cutoffTimestamp * 1000);
  const date = dateOfCycleDay(h.cycleDay);
  const wallets = await deps.computeWallets(
    h.cutoffNumber,
    blockTimestamp,
    clusters
  );
  const { adjustedSeasons, consolidatedTdh } = await deps.consolidate(
    wallets.tdh,
    blockTimestamp,
    clusters
  );
  const cache = compareChainDay(
    day,
    siteDayFromRows(h.cutoffNumber, date, wallets.tdh, consolidatedTdh)
  );

  const applied = applyChainValues(
    day,
    verification.clusters,
    wallets.tdh,
    consolidatedTdh,
    blockTimestamp
  );
  let walletRows = wallets.tdh;
  let consolidatedRows = consolidatedTdh;
  if (
    applied.overrides.length > 0 ||
    applied.addedWallets.length > 0 ||
    applied.addedIdentities.length > 0
  ) {
    const ranked = await deps.rerank(
      walletRows,
      consolidatedRows,
      blockTimestamp
    );
    walletRows = ranked.wallets;
    consolidatedRows = ranked.consolidated;
  }
  const base: IngestSummary = {
    mode,
    cycleDay: h.cycleDay,
    failures: [],
    cache: digest(cache),
    overrides: overrideDigest(applied.overrides),
    added: {
      wallets: applied.addedWallets.length,
      identities: applied.addedIdentities.length
    }
  };

  if (mode === 'SHADOW') {
    const live = await deps.readLive();
    const liveReport = compareChainDay(
      day,
      siteDayFromRows(h.cutoffNumber, date, live.wallets, live.consolidated)
    );
    const summary: IngestSummary = {
      ...base,
      live: digest(liveReport),
      rowDiff: {
        wallets: diffTable(walletRows, live.wallets, (r) =>
          r.wallet.toLowerCase()
        ),
        identities: diffTable(consolidatedRows, live.consolidated, (r) =>
          r.consolidation_key.toLowerCase()
        )
      }
    };
    await deps.saveDay({
      day,
      mode,
      status: 'INGESTED',
      verdict: liveReport.verdict,
      summary,
      deferredKeys: [],
      now: deps.now()
    });
    return {
      status: 'INGESTED',
      verdict: liveReport.verdict,
      deferredKeys: [],
      summary
    };
  }

  const width = await deps.keyWidth();
  const { fit, deferred } = splitByKeyWidth(consolidatedRows, width);
  const status: TdhChainDayStatus =
    deferred.length > 0 ? 'KEYS_DEFERRED' : 'INGESTED';
  const writeTime = new Date(day.apply.applyTimeMs ?? h.boundary * 1000);
  fit.forEach((row) => (row.date = writeTime));
  await deps.write({
    day,
    blockTimestamp,
    adjustedSeasons,
    wallets: { ...wallets, tdh: walletRows },
    consolidated: fit
  });
  const summary: IngestSummary = { ...base, deferredKeys: deferred.length };
  await deps.saveDay({
    day,
    mode,
    status,
    verdict: cache.verdict,
    summary,
    deferredKeys: deferred,
    now: deps.now()
  });
  return { status, verdict: cache.verdict, deferredKeys: deferred, summary };
}
