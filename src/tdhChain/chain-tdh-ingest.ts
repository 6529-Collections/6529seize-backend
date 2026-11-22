import { ConsolidatedTDH, TDH } from '@/entities/ITDH';
import { MemesSeason } from '@/entities/ISeason';
import { TdhClusterSource } from '@/tdhLoop/tdh-cluster-source';
import { applyChainValues, ChainOverride } from './apply-chain-values';
import { chainClusterSource } from './chain-cluster-source';
import {
  compareChainDay,
  CompareReport,
  CompareVerdict,
  DIFF_CLASSES
} from './chain-day-compare';
import {
  ChainDayFailure,
  EthBlockReader,
  verifyChainDay,
  verifyCutoff
} from './chain-day-verify';
import { dateOfCycleDay, SiteDay } from './site-day';
import { siteDayFromRows } from './site-day-rows';
import {
  CHAIN_DAY_STEPS,
  ChainDayStep,
  ChainDayStepState,
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
 * 2. CHAIN only: if the TDH tables already hold a newer block, record the
 *    day as SKIPPED and write nothing: an older day never replaces a newer
 *    one.
 * 3. Wait (record nothing) until the site's transaction index is past the
 *    cutoff block, or three hours past the boundary.
 * 4. Compute the site's own TDH at the chain's cutoff block, grouped by the
 *    chain's clusters, in memory: the breakdowns (base, raw, boost, seasons,
 *    editions) the chain doesn't carry. Compare it with the leaves exactly.
 * 5. Write the chain's values over it (`applyChainValues`) and rank again
 *    on them.
 * 6. SHADOW: compare the chain's day with the live tables too, and diff the
 *    rows the switch would write against them. Record the day; write no TDH
 *    table.
 *    CHAIN: leave out any consolidation whose key is wider than the columns
 *    (queued on the day's record), then write every TDH table, the
 *    tdh_blocks row, the identities sync marker and the day's record (as
 *    WRITTEN) in one transaction, and return. The poller sends the day's
 *    alerts, then runs the follow-up steps (`runFollowUpSteps`); a retry
 *    resumes the steps and never rewrites the tables. The identities sync
 *    and its "TDH calculations done" follow the write as they do for a full
 *    tdhLoop run.
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

/** A written day whose follow-up steps run. */
export interface ChainDayRef {
  readonly cycleDay: number;
  /** The cutoff block: the block the write recorded. */
  readonly block: number;
}

/** The follow-up steps of a CHAIN write, and where they stand. */
export interface ChainDayStepRunner {
  run(step: ChainDayStep, day: ChainDayRef): Promise<void>;
  markDone(cycleDay: number, step: ChainDayStep): Promise<ChainDayStepState>;
  /** Counts a failed run; returns the step's failed runs so far. */
  recordFailure(cycleDay: number, step: ChainDayStep): Promise<number>;
  giveUp(
    cycleDay: number,
    steps: readonly ChainDayStep[]
  ): Promise<ChainDayStepState>;
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
  readLive(block: number): Promise<LiveTdh>;
  /** Writes the day's TDH tables and its record in one transaction. */
  writeDay(rows: ChainTdhRows, record: SaveTdhChainDay): Promise<void>;
  keyWidth(): Promise<number>;
  /** The highest block the TDH tables hold, or 0. */
  latestTdhBlock(): Promise<number>;
  /** The highest block in the site's transaction index. */
  transactionsIndexedTo(): Promise<number>;
  saveDay(s: SaveTdhChainDay): Promise<void>;
  now(): number;
}

/** Blocks past the cutoff the transaction index must reach. */
export const INDEX_MARGIN_BLOCKS = 64;
/** After this long past the boundary, the index wait gives way. */
export const INDEX_WAIT_LIMIT_MS = 3 * 60 * 60 * 1000;

export type IngestStatus = TdhChainDayStatus | 'WAITING';

export interface ChainTdhIngestResult {
  readonly status: IngestStatus;
  readonly verdict: CompareVerdict | null;
  readonly deferredKeys: readonly string[];
  readonly summary: IngestSummary;
}

export interface IngestSummary {
  readonly mode: TdhChainDayMode;
  readonly cycleDay: number;
  readonly failures: readonly ChainDayFailure[];
  readonly note?: string;
  readonly cache?: ReportDigest;
  readonly live?: ReportDigest | { readonly error: string };
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
  readonly verdict: CompareVerdict;
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

/** Failed runs of one step before it is given up with an alert. */
export const MAX_STEP_TRIES = 12;

export interface FollowUpOutcome extends ChainDayStepState {
  /** The steps that failed in this run. */
  readonly failed: readonly ChainDayStep[];
}

/**
 * Runs the day's follow-up steps not yet done or given up, in order, each
 * marked done once it ran. The steps don't depend on each other, so a step
 * that fails is counted and the next one runs; the poll after tries the
 * failed one again. After MAX_STEP_TRIES failed runs a step is given up,
 * with an alert, and the day is done without it.
 */
export async function runFollowUpSteps(
  day: ChainDayRef & {
    readonly stepsDone: readonly ChainDayStep[];
    readonly stepsGivenUp: readonly ChainDayStep[];
  },
  runner: ChainDayStepRunner,
  alert: (title: string, message: string) => Promise<void>
): Promise<FollowUpOutcome> {
  let state: ChainDayStepState = {
    done: [...day.stepsDone],
    givenUp: [...day.stepsGivenUp]
  };
  const failed: ChainDayStep[] = [];
  for (const step of CHAIN_DAY_STEPS) {
    if (state.done.includes(step) || state.givenUp.includes(step)) continue;
    try {
      await runner.run(step, day);
    } catch (e) {
      const message = (e as Error).message;
      failed.push(step);
      const tries = await runner.recordFailure(day.cycleDay, step);
      if (tries >= MAX_STEP_TRIES) {
        state = await runner.giveUp(day.cycleDay, [step]);
        await alert(
          `TDH day ${day.cycleDay}: the ${step} step was given up`,
          `it failed ${tries} times; the last error: ${message}`
        );
      }
      continue;
    }
    state = await runner.markDone(day.cycleDay, step);
  }
  return { ...state, failed };
}

function liveSiteDay(
  day: TdhChainDay,
  live: LiveTdh
): SiteDay | { error: string } {
  try {
    return siteDayFromRows(
      day.header.cutoffNumber,
      dateOfCycleDay(day.header.cycleDay),
      live.wallets,
      live.consolidated
    );
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function ingestChainDay(
  day: TdhChainDay,
  mode: TdhChainDayMode,
  deps: ChainTdhIngestDeps
): Promise<ChainTdhIngestResult> {
  const h = day.header;
  const record = (
    status: TdhChainDayStatus,
    verdict: CompareVerdict | null,
    summary: IngestSummary,
    deferredKeys: readonly string[] = []
  ): SaveTdhChainDay => ({
    day,
    mode,
    status,
    verdict,
    summary,
    deferredKeys,
    now: deps.now()
  });

  const verification = verifyChainDay(day);
  const failures: ChainDayFailure[] = [...verification.failures];
  if (verification.ok) {
    failures.push(...(await verifyCutoff(h, deps.ethBlocks)));
  }
  if (failures.length > 0) {
    const summary: IngestSummary = { mode, cycleDay: h.cycleDay, failures };
    await deps.saveDay(record('FAILED', null, summary));
    return { status: 'FAILED', verdict: null, deferredKeys: [], summary };
  }

  if (mode === 'CHAIN') {
    const newest = await deps.latestTdhBlock();
    if (newest > h.cutoffNumber) {
      const summary: IngestSummary = {
        mode,
        cycleDay: h.cycleDay,
        failures: [],
        note: `the TDH tables already hold block ${newest}, newer than this day's ${h.cutoffNumber}`
      };
      await deps.saveDay(record('SKIPPED', null, summary));
      return { status: 'SKIPPED', verdict: null, deferredKeys: [], summary };
    }
  }

  const indexed = await deps.transactionsIndexedTo();
  if (
    indexed < h.cutoffNumber + INDEX_MARGIN_BLOCKS &&
    deps.now() < h.boundary * 1000 + INDEX_WAIT_LIMIT_MS
  ) {
    return {
      status: 'WAITING',
      verdict: null,
      deferredKeys: [],
      summary: {
        mode,
        cycleDay: h.cycleDay,
        failures: [],
        note: `the transaction index is at block ${indexed}, the cutoff is ${h.cutoffNumber}`
      }
    };
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
    const live = await deps.readLive(h.cutoffNumber);
    const site = liveSiteDay(day, live);
    const liveReport = 'error' in site ? null : compareChainDay(day, site);
    const summary: IngestSummary = {
      ...base,
      live: liveReport ? digest(liveReport) : { error: (site as any).error },
      rowDiff: {
        wallets: diffTable(walletRows, live.wallets, (r) =>
          r.wallet.toLowerCase()
        ),
        identities: diffTable(consolidatedRows, live.consolidated, (r) =>
          r.consolidation_key.toLowerCase()
        )
      }
    };
    const verdict = liveReport?.verdict ?? 'MISMATCH';
    await deps.saveDay(record('INGESTED', verdict, summary));
    return { status: 'INGESTED', verdict, deferredKeys: [], summary };
  }

  const width = await deps.keyWidth();
  const { fit, deferred } = splitByKeyWidth(consolidatedRows, width);
  const writeTime = new Date(day.apply.applyTimeMs ?? h.boundary * 1000);
  fit.forEach((row) => (row.date = writeTime));
  const summary: IngestSummary = { ...base, deferredKeys: deferred.length };
  await deps.writeDay(
    {
      day,
      blockTimestamp,
      adjustedSeasons,
      wallets: { ...wallets, tdh: walletRows },
      consolidated: fit
    },
    record('WRITTEN', cache.verdict, summary, deferred)
  );
  return {
    status: 'WRITTEN',
    verdict: cache.verdict,
    deferredKeys: deferred,
    summary
  };
}
