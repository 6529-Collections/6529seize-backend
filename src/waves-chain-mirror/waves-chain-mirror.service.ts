import { Logger } from '@/logging';
import { Time } from '@/time';
import { ConnectionWrapper } from '@/sql-executor';
import { WavesChainIndexDb } from '@/waves-chain-index/waves-chain-index.db';
import { writerPoolExecutor } from './waves-chain-mirror.writer';
import {
  EventCursorError,
  eventCursor,
  parseEventCursor
} from '@/waves-chain-index/waves-chain-index.events';
import { VoteEvent } from './waves-chain-mirror.history';
import {
  EMPTY_MIRROR_STATE,
  LoggedVote,
  WavesChainMirrorDb,
  wavesChainMirrorDb,
  WavesChainMirrorState
} from './waves-chain-mirror.db';
import { chainGatewayClient } from '@/chain-gateway/chain-gateway.client';
import {
  checkEntryManifest,
  DOC_CLASS,
  DocumentSource,
  StoredDocuments
} from './waves-chain-mirror.docs';
import { ContentGate, ModerationContentGate } from './waves-chain-mirror.gate';
import { isReleasedEntry } from './waves-chain-mirror.entries';
import {
  isMainStageDecision,
  isWavesFrozenAt
} from './waves-chain-mirror.freeze';
import {
  chainExecutionKeyPrefix,
  InvalidLegacyIds,
  nativeCompetitionId,
  resultDecisionId
} from './waves-chain-mirror.ids';
import {
  NativeEntryLookup,
  nativeEntryContent,
  participationRulesOf
} from './waves-chain-mirror.native-entries';
import {
  EntryChecker,
  entryCheckReads,
  ParticipationEntryChecker
} from './waves-chain-mirror.entry-checks';
import {
  DecisionPlan,
  planDecision,
  planWrites
} from './waves-chain-mirror.plan';
import {
  addChanges,
  addCounts,
  chainFinalResults,
  historyReadOf,
  historySinceOf,
  PlanCounter,
  retryDelayMs,
  TableChanges
} from './waves-chain-mirror.plan-support';
import {
  ObjectsReport,
  WavesChainObjectsMirror
} from './waves-chain-mirror.objects';
import { wavesChainObjectsDb } from './waves-chain-mirror.objects.db';
import {
  collaborationCheck,
  collaborationReads,
  CollaborationReads
} from './waves-chain-mirror.collaborations';
import { nativeEntryModel } from './waves-chain-mirror.apply';
import { defaultObjectEffects } from './waves-chain-mirror.objects.effects';
import {
  ChainDecisionState,
  ChainEntryRow,
  MirrorLookups,
  SkippedClaimBuild,
  TargetCompetitionState
} from './waves-chain-mirror.types';

const logger = Logger.get('WAVES_CHAIN_MIRROR');

/**
 * 6529.io's copy of the 6529 chain's decisions in its own competition
 * tables, so every route that reads them (v3 and, through the legacy views,
 * every older GET and every drop object) shows what the chain counts.
 *
 * Input is the chain index (src/waves-chain-index): its chain_* rows at the
 * height it has applied, and its event log. Each run:
 * 1. writes only while the waves freeze holds 6529.io's own runtime (the
 *    freeze flag's rule: FEATURE_WAVES_FROZEN, or WAVES_FREEZE_AT has
 *    passed), and leaves the Main Stage decision alone while
 *    FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE keeps the runtime running it; it
 *    waits for the index's first full read and for the identity mirror's
 *    principal map;
 * 2. mirrors the chain's groups and waves (waves-chain-mirror.objects.ts);
 * 3. reads the event log after its cursor: each event names a decision to
 *    mirror again; a GAP starts a full pass;
 * 4. mirrors the decisions that failed last run, those the events name, the
 *    live counted ones (their scores move with block time) and every
 *    decision the index read again since the last run. The cursor moves on
 *    past a decision that fails: it reads its own VOTE events again when it
 *    is next tried (state.replayFrom), so it holds no other decision back;
 * 5. goes on with a full pass over every decision, when one is under way:
 *    every hour, after a GAP, a new full read of the index, a bad cursor or
 *    a relaunched chain.
 * Each decision is one transaction (READ COMMITTED, retried on a deadlock)
 * that locks the competition row, reads 6529.io's rows, and writes the
 * difference (waves-chain-mirror.plan.ts). Writes are state keyed by
 * derived ids, so a run can repeat another's work.
 *
 * Without WAVES_CHAIN_MIRROR_WRITE=true it only reports: it plans every
 * group, wave and decision against 6529.io's rows and logs what it would
 * write, writing nothing but where its pass got to (its own state row).
 *
 * Before a decision's transaction it reads what that transaction can't:
 * block times from the event log, and for each entry made on the chain
 * that 6529.io has no row of, its manifest (chain_docs, else the gateway's
 * store), checked and validated, and, when writing, judged by
 * pre-publication moderation once (a refusal is kept in chain_entry_holds).
 *
 * The competition outbox gets the socket and notification events the
 * runtime queues with the same writes, never a claim: the chain's claims
 * are the chain index's (chain_claim_builds), and the dispatcher's claim
 * path leaves out a decision keyed `chain:`.
 */

/** A full pass runs at least this often. */
export const FULL_PASS_EVERY_MS = Time.hours(1).toMillis();
/** Events read per page, and pages a run reads at most. */
const EVENT_PAGE = 1000;
const EVENT_PAGES = 20;
/** A failed decision's VOTE events read again in one run, at most. */
const REPLAY_EVENTS = 5_000;
/** Decision ids a full pass reads at a time. */
const FULL_PAGE = 200;
/** Decisions with differences a report lists. */
const REPORT_DIFFERENCES = 25;
/** A decision is not started with less than this left. */
const DECISION_RESERVE_MS = 1_500;
const DEADLOCK_ATTEMPTS = 3;

export interface WavesChainMirrorSettings {
  /** WAVES_CHAIN_MIRROR_WRITE=true: write; otherwise report only. */
  readonly write: boolean;
  /**
   * The waves freeze is on (FEATURE_WAVES_FROZEN, or WAVES_FREEZE_AT has
   * passed): 6529.io's runtime holds every decision but a kept Main Stage.
   */
  readonly frozen: boolean;
  /**
   * FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE: the runtime still runs the Main
   * Stage decision, which the mirror then leaves to it.
   */
  readonly keepMainStage: boolean;
  /** MAIN_STAGE_WAVE_ID: the freeze flag's fallback Main Stage wave. */
  readonly mainStageWaveId: string | null;
}

export function mirrorSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now()
): WavesChainMirrorSettings {
  return {
    write: env.WAVES_CHAIN_MIRROR_WRITE === 'true',
    frozen: isWavesFrozenAt(env, now),
    keepMainStage: env.FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE === 'true',
    mainStageWaveId: env.MAIN_STAGE_WAVE_ID?.trim() || null
  };
}

export type MirrorSkip = 'not_frozen' | 'index_not_ready' | 'no_principal_map';

export interface WavesChainMirrorReport {
  mode: 'skipped' | 'report' | 'write';
  skipped?: MirrorSkip;
  /** The index's applied height the run read. */
  height: number | null;
  network: string | null;
  events: number;
  cursor: string | null;
  full: {
    running: boolean;
    /** Why a full pass started this run. */
    started: string | null;
    completed: boolean;
    after: string | null;
  };
  decisions: {
    mirrored: number;
    unchanged: number;
    skipped: Record<string, number>;
    failed: number;
    /** Decisions the run had no time left for. */
    left: number;
  };
  /** Rows written (or, reporting, that would be), by table. */
  changes: Record<string, TableChanges>;
  /** Chain rows waiting for a mapping, by reason. */
  waiting: Record<string, number>;
  /**
   * Rows written short of the chain's, by reason (an imported wave's
   * description drop id its document gave and couldn't be used).
   */
  notes: Record<string, number>;
  /** The chain's groups and waves (written before its decisions). */
  objects: ObjectsReport | null;
  /**
   * The chain's objects this mirror left out so far (its runs together)
   * for a legacy id that isn't an RFC 4122 UUID.
   */
  invalidLegacyIds: number;
  /** Report-only: the first decisions with differences. */
  differences: {
    decisionId: string;
    competitionId: string;
    changes: Record<string, TableChanges>;
  }[];
}

/** How a run mirrors: writing or not, and the chain's network id. */
interface MirrorRun {
  readonly write: boolean;
  readonly network: string | null;
  readonly keepMainStage: boolean;
  readonly mainStageWaveId: string | null;
  /** The VOTE events this run read after the cursor, by decision. */
  readonly voteEvents: ReadonlyMap<string, readonly VoteEvent[]>;
  /** Failed decisions' VOTE events from before the cursor, read again. */
  readonly replay: Replay;
  /**
   * Votes set above this height get their block's time looked up: the
   * index's height at the last run, 0 in a full pass or a report.
   */
  readonly timesFrom: number;
}

/** The VOTE events of decisions that failed after the cursor passed them. */
interface Replay {
  /** Each one's cursor after which its events are read again. */
  readonly from: ReadonlyMap<string, string | null>;
  /** The run's own read starts after this; a replay reads up to it. */
  readonly upTo: string | null;
  /** Those this run's replay stopped short for: where it got to. */
  readonly behind: Map<string, string>;
}

const NO_REPLAY: Replay = { from: new Map(), upTo: null, behind: new Map() };

type DecisionOutcome =
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'planned'; readonly plan: DecisionPlan };

/** What the mirror reads and writes; tests give their own. */
export type MirrorStore = Pick<
  WavesChainMirrorDb,
  | 'loadState'
  | 'saveState'
  | 'hasPrincipalMap'
  | 'decisionIdsAfter'
  | 'liveDecisionIds'
  | 'decisionIdsChangedAbove'
  | 'chainDecision'
  | 'blockTimes'
  | 'resultFinalTimes'
  | 'releasedVotes'
  | 'profilesOfPrincipals'
  | 'profilesWithPrincipal'
  | 'targetCompetition'
  | 'applyWrites'
  | 'inTransaction'
  | 'nativeEntryContext'
  | 'heldEntries'
  | 'holdEntry'
  | 'findDocument'
  | 'saveDocument'
  | 'skippedClaimBuilds'
  | 'releaseHold'
  | 'loadReportPlace'
  | 'saveReportPlace'
  | 'removeOtherNetworksResults'
  | 'releaseChainMadeEntries'
  | 'decisionVoteEvents'
  | 'writeImportedDecisionRows'
>;

export type MirrorIndex = Pick<WavesChainIndexDb, 'loadState' | 'readEvents'>;

export function isDeadlock(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  return code === 'ER_LOCK_DEADLOCK' || errno === 1213;
}

/** Chain-side lookups of a decision, read once outside the transaction. */
interface ChainLookups {
  readonly blockTimes: Map<number, number>;
  readonly resultFinalTimes: Map<number, number>;
  readonly releasedVotes: Map<string, Map<string, string>>;
  /** Entries made on the chain that 6529.io has no row of yet. */
  readonly nativeEntries: Map<string, NativeEntryLookup>;
  readonly skippedClaimBuilds: SkippedClaimBuild[];
  /** The decision's VOTE events to write the history of, in log order. */
  readonly voteEvents: readonly VoteEvent[];
}

export class WavesChainMirror {
  constructor(
    private readonly store: MirrorStore,
    private readonly index: MirrorIndex,
    private readonly settings: (now: number) => WavesChainMirrorSettings = (
      now
    ) => mirrorSettingsFromEnv(process.env, now),
    private readonly clock: () => number = () => Date.now(),
    /** Documents; a report-only run keeps none it fetches. */
    private readonly documents: (keep: boolean) => DocumentSource = (keep) =>
      new StoredDocuments(store, chainGatewayClient, keep),
    private readonly gate: ContentGate = new ModerationContentGate(),
    private readonly checker: EntryChecker = new ParticipationEntryChecker(
      entryCheckReads(() => writerPoolExecutor)
    ),
    /** A finalized block's time from the gateway; null when unknown. */
    private readonly blockTime: (height: number) => Promise<number | null> = (
      height
    ) => gatewayBlockTime(height),
    /** The chain's groups and waves; none to mirror when null. */
    private readonly objects: Pick<
      WavesChainObjectsMirror,
      'run'
    > | null = null,
    /** What the collaboration write's checks read. */
    private readonly collaborations: CollaborationReads = collaborationReads,
    /** Objects left out for a legacy id that isn't an RFC 4122 UUID. */
    private readonly legacyIds: InvalidLegacyIds = new InvalidLegacyIds(
      (message) => logger.warn(`[WAVES CHAIN MIRROR] ${message}`)
    )
  ) {}

  async run({
    budgetMs
  }: {
    budgetMs: number;
  }): Promise<WavesChainMirrorReport> {
    const deadline = this.clock() + budgetMs;
    const settings = this.settings(this.clock());
    const report = emptyReport(settings.write ? 'write' : 'report');
    const skip = (reason: MirrorSkip) => {
      report.mode = 'skipped';
      report.skipped = reason;
      return report;
    };
    // Before the freeze the runtime writes the same rows.
    if (settings.write && !settings.frozen) return skip('not_frozen');
    const index = await this.index.loadState();
    if (index.lastFullAt === null || index.feedNext === null) {
      return skip('index_not_ready');
    }
    if (!(await this.store.hasPrincipalMap())) return skip('no_principal_map');
    report.height = index.feedNext - 1;
    report.network = index.network;
    if (settings.write) {
      await this.writeRun(report, index, settings, deadline);
    } else {
      await this.reportAll(report, settings, deadline);
    }
    report.invalidLegacyIds = this.legacyIds.count;
    return report;
  }

  // ------------------------------------------------------------ report only

  /**
   * Plans every decision, ascending, writing nothing to 6529.io: only its
   * place, in its own state row.
   */
  private async reportAll(
    report: WavesChainMirrorReport,
    settings: WavesChainMirrorSettings,
    deadline: number
  ) {
    await this.mirrorObjects(false, report, deadline);
    // A pass that didn't finish goes on where it stopped, in the next run.
    report.full.running = true;
    report.full.started = 'report';
    const start = await this.store.loadReportPlace();
    let after = start;
    for (;;) {
      const ids = await this.store.decisionIdsAfter(after, FULL_PAGE);
      if (!ids.length) {
        report.full.running = false;
        report.full.completed = true;
        if (start !== null)
          await this.store.saveReportPlace(null, this.clock());
        return;
      }
      for (const id of ids) {
        if (this.outOfTime(deadline)) {
          report.decisions.left++;
          continue;
        }
        await this.mirrorOne(
          id,
          {
            write: false,
            network: report.network,
            keepMainStage: settings.keepMainStage,
            mainStageWaveId: settings.mainStageWaveId,
            voteEvents: new Map(),
            replay: NO_REPLAY,
            timesFrom: 0
          },
          report
        );
        after = id;
      }
      report.full.after = after;
      if (this.outOfTime(deadline)) {
        await this.store.saveReportPlace(after, this.clock());
        return;
      }
    }
  }

  // ------------------------------------------------------------ writing

  private async writeRun(
    report: WavesChainMirrorReport,
    index: Awaited<ReturnType<MirrorIndex['loadState']>>,
    settings: WavesChainMirrorSettings,
    deadline: number
  ) {
    const now = this.clock();
    let state: WavesChainMirrorState = await this.store.loadState();
    let startReason: string | null = null;
    if (state.network !== index.network) {
      // A relaunched chain (or the first run): its log and ids are new.
      if (state.network !== null) {
        logger.warn(
          `[NETWORK ${state.network} -> ${index.network}] the mirror starts again`
        );
        startReason = 'network';
        // The old chain's results go; the new chain's are written again.
        const removed = await this.store.removeOtherNetworksResults(
          chainExecutionKeyPrefix(index.network)
        );
        // Its entries made on the chain are released as withdrawn ones are.
        const released = await this.store.releaseChainMadeEntries();
        logger.warn(
          `[NETWORK] removed ${removed} result(s) and released ${released} entr(ies) of the old network`
        );
      }
      state = { ...EMPTY_MIRROR_STATE, network: index.network };
      // Saved now: a run that fails later doesn't release the new chain's
      // entries as the old one's.
      await this.store.saveState(state, now);
    }
    // The event log after the cursor: the decisions its events name.
    const touched = new Set<string>();
    const voteEvents = new Map<string, VoteEvent[]>();
    // The cursor before each decision's first event read this run: a
    // decision that fails reads its VOTE events again from there when next
    // tried (their history is written once: waves_chain_mirror_events).
    const before = new Map<string, string | null>();
    const replayFrom = new Map(Object.entries(state.replayFrom));
    let replayUpTo = state.eventsCursor;
    let cursor = state.eventsCursor;
    try {
      for (let page = 0; page < EVENT_PAGES; page++) {
        const read = await this.index.readEvents(cursor, EVENT_PAGE);
        let previous = cursor;
        for (const event of read.events) {
          if (event.kind === 'GAP') startReason ??= 'gap';
          if (event.decisionId && !before.has(event.decisionId)) {
            before.set(event.decisionId, previous);
          }
          previous = eventCursor(event, read.network ?? index.network);
          if (event.decisionId) touched.add(event.decisionId);
          const vote = voteEventOf(event);
          if (vote && event.decisionId) {
            const list = voteEvents.get(event.decisionId) ?? [];
            list.push(vote);
            voteEvents.set(event.decisionId, list);
          }
        }
        report.events += read.events.length;
        cursor = read.next;
        if (read.events.length < EVENT_PAGE || this.outOfTime(deadline)) break;
      }
    } catch (error) {
      if (!(error instanceof EventCursorError)) throw error;
      logger.warn(`[EVENT CURSOR] ${error.message}; reading the log again`);
      cursor = null;
      before.clear();
      // The log is read from its start: nothing before it to read again.
      replayFrom.clear();
      replayUpTo = null;
      startReason ??= 'cursor';
    }
    if (state.lastFullAt === null) startReason ??= 'first';
    else if (now - state.lastFullAt >= FULL_PASS_EVERY_MS)
      startReason ??= 'hourly';
    if (index.generation !== state.indexGeneration)
      startReason ??= 'index_full_read';
    if (startReason && !state.fullRunning) {
      state = { ...state, fullRunning: true, fullAfter: null };
      report.full.started = startReason;
    }

    // Groups and waves first: a decision's rows and the drop index's drops
    // need them.
    await this.mirrorObjects(true, report, deadline);
    // Decisions that changed or move with time, then the full pass.
    const run: MirrorRun = {
      write: true,
      network: index.network,
      keepMainStage: settings.keepMainStage,
      mainStageWaveId: settings.mainStageWaveId,
      voteEvents,
      replay: { from: replayFrom, upTo: replayUpTo, behind: new Map() },
      timesFrom: state.indexHeight ?? 0
    };
    const done = new Set<string>();
    const changed =
      state.indexHeight === null
        ? []
        : await this.store.decisionIdsChangedAbove(state.indexHeight);
    const live = await this.store.liveDecisionIds();
    // Decisions that failed last run first. Their votes set since they
    // failed get their block's time looked up, as in a full pass.
    const retrying = new Set([
      ...state.retryIds,
      ...Array.from(replayFrom.keys())
    ]);
    const incremental = Array.from(
      new Set([
        ...Array.from(retrying),
        ...Array.from(touched),
        ...live,
        ...changed
      ])
    );
    const failed = new Set<string>();
    for (const id of incremental) {
      if (this.outOfTime(deadline)) {
        report.decisions.left++;
        continue;
      }
      const ok = await this.mirrorOne(
        id,
        retrying.has(id) ? { ...run, timesFrom: 0 } : run,
        report
      );
      if (!ok) failed.add(id);
      done.add(id);
    }
    const incrementalDone = incremental.every((id) => done.has(id));
    if (state.fullRunning) {
      state = await this.continueFull(
        state,
        run,
        done,
        failed,
        report,
        deadline,
        now
      );
    }
    // A failed decision is tried again next run, until it goes through; one
    // not reached keeps its place.
    const retryIds = Array.from(
      new Set([
        ...Array.from(failed),
        ...state.retryIds.filter((id) => !done.has(id))
      ])
    );
    report.full.running = state.fullRunning;
    report.full.after = state.fullAfter;
    const replayNext = nextReplayFrom(
      replayFrom,
      before,
      failed,
      done,
      run.replay.behind
    );
    if (replayNext.size) {
      logger.warn(
        `[EVENT CURSOR] ${replayNext.size} decision(s) read their VOTE events again when next tried`
      );
    }
    state = {
      ...state,
      network: index.network,
      indexGeneration: index.generation,
      // Not all done: the same events and rows are read again next run.
      eventsCursor: incrementalDone ? cursor : state.eventsCursor,
      indexHeight: incrementalDone ? report.height : state.indexHeight,
      retryIds: Array.from(
        new Set([...retryIds, ...Array.from(replayNext.keys())])
      ),
      replayFrom: Object.fromEntries(replayNext),
      lastError: failed.size
        ? `${failed.size} decision(s) failed; see the log`
        : null
    };
    report.cursor = state.eventsCursor;
    await this.store.saveState(state, this.clock());
  }

  private async continueFull(
    state: WavesChainMirrorState,
    run: MirrorRun,
    done: Set<string>,
    failed: Set<string>,
    report: WavesChainMirrorReport,
    deadline: number,
    now: number
  ): Promise<WavesChainMirrorState> {
    let after = state.fullAfter;
    for (;;) {
      const ids = await this.store.decisionIdsAfter(after, FULL_PAGE);
      if (!ids.length) {
        report.full.completed = true;
        return {
          ...state,
          fullRunning: false,
          fullAfter: null,
          lastFullAt: now
        };
      }
      for (const id of ids) {
        if (this.outOfTime(deadline)) {
          return { ...state, fullAfter: after };
        }
        // A decision that fails is passed over (logged) and tried again
        // next run.
        if (
          !done.has(id) &&
          !(await this.mirrorOne(id, { ...run, timesFrom: 0 }, report))
        ) {
          failed.add(id);
        }
        done.add(id);
        after = id;
      }
    }
  }

  /** The chain's groups and waves (waves-chain-mirror.objects.ts). */
  private async mirrorObjects(
    write: boolean,
    report: WavesChainMirrorReport,
    deadline: number
  ): Promise<void> {
    if (!this.objects) return;
    const counter = new PlanCounter();
    try {
      report.objects = await this.objects.run({
        write,
        documents: this.documents(write),
        counter,
        outOfTime: () => this.outOfTime(deadline),
        legacyIds: this.legacyIds
      });
    } catch (error) {
      logger.error(`[WAVES CHAIN MIRROR] groups and waves failed: ${error}`);
    }
    addChanges(report.changes, counter.changes);
    addCounts(report.waiting, counter.waiting);
    addCounts(report.notes, counter.notes);
  }

  private outOfTime(deadline: number): boolean {
    return this.clock() > deadline - DECISION_RESERVE_MS;
  }

  // ------------------------------------------------------------ a decision

  /** Mirrors (or reports) one decision; false when it failed. */
  private async mirrorOne(
    decisionId: string,
    run: MirrorRun,
    report: WavesChainMirrorReport
  ): Promise<boolean> {
    try {
      const outcome = await this.mirrorDecision(decisionId, run);
      if (outcome.kind === 'skipped') {
        addCounts(report.decisions.skipped, { [outcome.reason]: 1 });
        return true;
      }
      const { plan } = outcome;
      addChanges(report.changes, plan.changes);
      addCounts(report.waiting, plan.waiting);
      if (planWrites(plan)) {
        report.decisions.mirrored++;
        if (!run.write && report.differences.length < REPORT_DIFFERENCES) {
          report.differences.push({
            decisionId,
            competitionId: plan.competitionId,
            changes: plan.changes
          });
        }
      } else {
        report.decisions.unchanged++;
      }
      return true;
    } catch (error) {
      report.decisions.failed++;
      logger.error(
        `[WAVES CHAIN MIRROR] decision ${decisionId} failed: ${error}`
      );
      return false;
    }
  }

  /**
   * A decision with its legacy ids as 6529.io writes them: null when its
   * own isn't an RFC 4122 UUID (left out); an entry whose legacy id isn't
   * one is left out of it (6529.io has no row of it).
   */
  private withLegacyIds(chain: ChainDecisionState): ChainDecisionState | null {
    const legacyId = this.legacyIds.of(
      'decision',
      chain.decision.decisionId,
      chain.decision.legacyId
    );
    if (legacyId === undefined) return null;
    const entries: ChainEntryRow[] = [];
    for (const entry of chain.entries) {
      const id = this.legacyIds.of('entry', entry.entryId, entry.legacyId);
      if (id !== undefined) entries.push({ ...entry, legacyId: id });
    }
    return { ...chain, decision: { ...chain.decision, legacyId }, entries };
  }

  private async mirrorDecision(
    decisionId: string,
    run: MirrorRun
  ): Promise<DecisionOutcome> {
    const read = await this.store.chainDecision(decisionId);
    if (!read) return { kind: 'skipped', reason: 'gone' };
    const chain = this.withLegacyIds(read);
    if (!chain) return { kind: 'skipped', reason: 'legacy_id_invalid' };
    // A decision made on the chain has its row once the groups-and-waves
    // pass wrote it (no_competition until then).
    const competitionId =
      chain.decision.legacyId ?? nativeCompetitionId(chain.decision.decisionId);
    const resultIds = chainFinalResults(chain).map((r) =>
      resultDecisionId(competitionId, r.resultTime)
    );
    const chainLookups = await this.chainLookups(chain, competitionId, run);
    const plan = async (
      connection?: ConnectionWrapper<any>
    ): Promise<DecisionOutcome> => {
      // A rebuild's rows of an imported decision's entries and results
      // 6529.io has none of (the live mirror writes none).
      const imported =
        connection && chain.decision.legacyId
          ? await this.store.writeImportedDecisionRows(
              chain,
              competitionId,
              connection
            )
          : {};
      const target = await this.store.targetCompetition(
        competitionId,
        resultIds,
        historyReadOf(chain),
        connection
      );
      if (!target) return { kind: 'skipped', reason: 'no_competition' };
      // The runtime still runs the Main Stage: its rows are the runtime's.
      if (
        run.keepMainStage &&
        isMainStageDecision(target.competition, run.mainStageWaveId)
      ) {
        return { kind: 'skipped', reason: 'main_stage_kept' };
      }
      const lookups = await this.lookups(
        run,
        chain,
        target,
        chainLookups,
        connection
      );
      const planned = planDecision({ chain, target, lookups });
      addCounts(planned.waiting, imported);
      if (connection && planWrites(planned)) {
        await this.store.applyWrites(planned, connection);
      }
      return { kind: 'planned', plan: planned };
    };
    if (!run.write) return plan();
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.store.inTransaction(plan);
      } catch (error) {
        if (!isDeadlock(error) || attempt >= DEADLOCK_ATTEMPTS) throw error;
        logger.warn(
          `[WAVES CHAIN MIRROR] decision ${decisionId}: deadlock, attempt ${attempt}`
        );
      }
    }
  }

  private async chainLookups(
    chain: ChainDecisionState,
    competitionId: string,
    run: MirrorRun
  ): Promise<ChainLookups> {
    // Votes' heights above `timesFrom` (a new vote's time; an older vote
    // keeps its row's) and results' (when one went final, if the log has no
    // RESULT_FINAL for it).
    const heights = [
      ...chain.votes
        .map((v) => v.updatedHeight)
        .filter((h) => h > run.timesFrom),
      ...chainFinalResults(chain)
        .map((r) => Number(r.data.settledHeight))
        .filter((h) => Number.isSafeInteger(h) && h > 0)
    ];
    // The newest result's winners: an older result's winner votes were
    // written with its decision row (they are written once).
    const winners = Array.from(
      new Set(
        chainFinalResults(chain)
          .slice(-1)
          .flatMap((r) =>
            (Array.isArray(r.data.winners) ? r.data.winners : [])
              .map((w) => (w as Record<string, unknown>).entryId)
              .filter((id): id is string => typeof id === 'string')
              .map((id) => id.toLowerCase())
          )
      )
    );
    const blockTimes = heights.length
      ? await this.store.blockTimes(heights)
      : new Map<number, number>();
    // The few the log has no event at, from the gateway.
    const unknown = Array.from(new Set(heights))
      .filter((h) => !blockTimes.has(h))
      .slice(0, GATEWAY_BLOCK_TIMES);
    for (const height of unknown) {
      const time = await this.blockTime(height);
      if (time !== null) blockTimes.set(height, time);
    }
    return {
      blockTimes,
      resultFinalTimes: chain.results.length
        ? await this.store.resultFinalTimes(chain.decision.decisionId)
        : new Map(),
      releasedVotes: winners.length
        ? await this.store.releasedVotes(winners)
        : new Map(),
      nativeEntries: await this.nativeEntries(chain, competitionId, run),
      skippedClaimBuilds: await this.store.skippedClaimBuilds(
        chain.decision.decisionId
      ),
      voteEvents: await this.voteEventsOf(chain, run)
    };
  }

  /**
   * A decision's VOTE events: those this run read after the cursor, and,
   * for one that failed after the cursor passed it, its own read again
   * from the log first. A replay that stops at its limit leaves out this
   * run's: they come after it, next run.
   */
  private async voteEventsOf(
    chain: ChainDecisionState,
    run: MirrorRun
  ): Promise<readonly VoteEvent[]> {
    const decisionId = chain.decision.decisionId;
    const read = run.voteEvents.get(decisionId) ?? [];
    const upTo = parseEventCursor(run.replay.upTo);
    if (!run.replay.from.has(decisionId) || upTo === null) return read;
    const logged = await this.store.decisionVoteEvents(
      decisionId,
      chain.entries.map((e) => e.entryId),
      parseEventCursor(run.replay.from.get(decisionId)),
      upTo,
      REPLAY_EVENTS + 1
    );
    const again = logged
      .slice(0, REPLAY_EVENTS)
      .map(voteEventOf)
      .filter((v): v is VoteEvent => v !== null);
    if (logged.length > REPLAY_EVENTS) {
      const last = logged[REPLAY_EVENTS - 1];
      run.replay.behind.set(decisionId, eventCursor(last, run.network));
      return again;
    }
    const place = (v: VoteEvent) => `${v.height}:${v.seq}`;
    const seen = new Set(again.map(place));
    return [...again, ...read.filter((v) => !seen.has(place(v)))];
  }

  /**
   * The content of each entry made on the chain that 6529.io has no row
   * of: its manifest read and checked, its fields validated, and, when
   * writing, its content past moderation (a refusal is kept, so it is
   * judged once). Done before the decision's transaction: it reads the
   * gateway and may ask the moderation evaluator. An entry left out has
   * no readable manifest yet, or no mapped author.
   */
  private async nativeEntries(
    chain: ChainDecisionState,
    competitionId: string,
    run: MirrorRun
  ): Promise<Map<string, NativeEntryLookup>> {
    const out = new Map<string, NativeEntryLookup>();
    const candidates = chain.entries.filter(
      (e) => e.legacyId === null && !isReleasedEntry(e)
    );
    if (!candidates.length) return out;
    const context = await this.store.nativeEntryContext(
      competitionId,
      candidates.map((e) => e.entryId)
    );
    if (!context) return out;
    const needed = candidates.filter((e) => !context.existing.has(e.entryId));
    if (!needed.length) return out;
    const now = this.clock();
    const held = await this.store.heldEntries(needed.map((e) => e.entryId));
    const authors = await this.store.profilesOfPrincipals(
      needed.map((e) => e.author)
    );
    const documents = this.documents(run.write);
    // A delay (retry later, waiting longer each time) and a refusal (for
    // good); a report-only run keeps neither.
    const hold = async (entryId: string, reason: string, delay: boolean) => {
      if (!run.write) return;
      const attempts = (held.get(entryId)?.attempts ?? 0) + 1;
      await this.store.holdEntry(
        entryId,
        competitionId,
        {
          reason,
          retryAt: delay ? now + retryDelayMs(attempts) : null,
          attempts
        },
        now
      );
    };
    for (const entry of needed) {
      const stored = held.get(entry.entryId);
      if (stored && (stored.retryAt === null || stored.retryAt > now)) {
        if (stored.reason !== MANIFEST_MISSING) {
          out.set(entry.entryId, { ok: false, reason: stored.reason });
        }
        continue;
      }
      const authorProfileId = authors.get(entry.author);
      if (!authorProfileId) continue;
      const subject = {
        entryId: entry.entryId,
        decisionId: entry.decisionId,
        author: entry.author,
        manifestHash: stringOrNull(entry.data.manifestHash),
        contentCid: stringOrNull(entry.data.contentCid)
      };
      if (!subject.contentCid || !subject.manifestHash) {
        out.set(entry.entryId, { ok: false, reason: 'no_manifest_reference' });
        continue;
      }
      let bytes: Uint8Array | null;
      try {
        bytes = await documents.get(
          subject.contentCid,
          DOC_CLASS.ENTRY_MANIFEST
        );
      } catch (error) {
        logger.warn(
          `[WAVES CHAIN MIRROR] entry ${entry.entryId}: manifest not read: ${error}`
        );
        bytes = null;
      }
      if (!bytes) {
        // Not in the store yet: asked again later, not every run.
        await hold(entry.entryId, MANIFEST_MISSING, true);
        continue;
      }
      const checked = checkEntryManifest(bytes, subject);
      if (!checked.ok) {
        // Its bytes are fixed by its CID: it will never check.
        await hold(entry.entryId, checked.reason, false);
        out.set(entry.entryId, checked);
        continue;
      }
      const content = nativeEntryContent(checked.manifest, {
        waveId: context.waveId,
        rules: participationRulesOf(context.participation)
      });
      const found = content.ok
        ? await this.checker.check({
            manifest: checked.manifest,
            content: content.content,
            authorProfileId,
            context: { ...context, competitionId }
          })
        : content;
      if (found.ok) {
        // The collaboration write's own checks, before the transaction: an
        // entry they refuse is held, not the whole decision failed.
        const collaboration = await collaborationCheck(
          nativeEntryModel({
            entryRowId: '',
            dropId: entry.entryId,
            waveId: context.waveId,
            authorId: authorProfileId,
            createdAt: 0,
            configVersion: 1,
            content: found.content
          }),
          competitionId,
          this.collaborations
        );
        if (!collaboration.ok) {
          await hold(entry.entryId, collaboration.reason, collaboration.delay);
          out.set(entry.entryId, { ok: false, reason: collaboration.reason });
          continue;
        }
      }
      if (found.ok && run.write) {
        const verdict = await this.gate.check({
          dropId: entry.entryId,
          authorProfileId,
          waveId: context.waveId,
          content: found.content
        });
        if (verdict.kind !== 'allowed') {
          const reason =
            verdict.kind === 'refused' ? 'moderation' : 'moderation_deferred';
          await hold(entry.entryId, reason, verdict.kind === 'deferred');
          out.set(entry.entryId, { ok: false, reason });
          continue;
        }
        if (stored) await this.store.releaseHold(entry.entryId);
      }
      out.set(entry.entryId, found);
    }
    return out;
  }

  private async lookups(
    run: MirrorRun,
    chain: ChainDecisionState,
    target: TargetCompetitionState,
    chainLookups: ChainLookups,
    connection?: ConnectionWrapper<any>
  ): Promise<MirrorLookups> {
    const principals = new Set<string>();
    for (const vote of chain.votes) principals.add(vote.voter);
    for (const entry of chain.entries) principals.add(entry.author);
    // A vote event's voter may have no vote left (one taken back to 0).
    for (const event of chainLookups.voteEvents) principals.add(event.voter);
    Array.from(chainLookups.releasedVotes.values()).forEach((votes) =>
      Array.from(votes.keys()).forEach((voter) => principals.add(voter))
    );
    const profiles = await this.store.profilesOfPrincipals(
      Array.from(principals),
      connection
    );
    const withPrincipal = await this.store.profilesWithPrincipal(
      target.votes.map((v) => v.voterProfileId),
      connection
    );
    const none = new Map<string, string>();
    return {
      network: run.network,
      now: this.clock(),
      profileOf: (principal) => profiles.get(principal) ?? null,
      hasPrincipal: (profileId) => withPrincipal.has(profileId),
      blockTime: (height) => chainLookups.blockTimes.get(height) ?? null,
      resultFinalTime: (resultTime) =>
        chainLookups.resultFinalTimes.get(resultTime) ?? null,
      releasedVotes: (entryId) =>
        chainLookups.releasedVotes.get(entryId) ?? none,
      nativeEntry: (entryId) => chainLookups.nativeEntries.get(entryId) ?? null,
      voteEvents: () => chainLookups.voteEvents,
      skippedClaimBuilds: () => chainLookups.skippedClaimBuilds
    };
  }
}

/** A VOTE event of the log as the history takes it; null for another. */
export function voteEventOf(event: LoggedVote): VoteEvent | null {
  if (event.kind !== 'VOTE' || !event.entryId || !event.actor) return null;
  const data = event.data;
  const newValue = stringOrNull(data.newValue);
  if (newValue === null) return null;
  return {
    height: event.height,
    seq: event.seq,
    blockTime: event.blockTime,
    origin: event.origin,
    entryId: event.entryId,
    voter: event.actor,
    oldValue: stringOrNull(data.oldValue),
    newValue,
    entryTotalAfter: stringOrNull(data.entryTotalAfter)
  };
}

/** Block times a decision asks the gateway for at most, each run. */
const GATEWAY_BLOCK_TIMES = 20;

/** A finalized block's time (/v1/blocks/{height}); null when unknown. */
export async function gatewayBlockTime(height: number): Promise<number | null> {
  try {
    const answer = await chainGatewayClient.read<{ time?: unknown }>(
      `/v1/blocks/${height}`
    );
    const time = Number(answer?.data?.time);
    return Number.isSafeInteger(time) && time > 0 ? time : null;
  } catch {
    return null;
  }
}

/** The hold of an entry whose manifest the store doesn't have yet. */
export const MANIFEST_MISSING = 'manifest_missing';
export { historySinceOf, retryDelayMs };

/**
 * The decisions that read their VOTE events again when next tried, and
 * from where, after a run: one that failed, from where it was to read
 * again or else from before its first event read this run; one not
 * reached, from where it was; one whose replay stopped short, from where
 * it got to. One that went through reads none again.
 */
export function nextReplayFrom(
  from: ReadonlyMap<string, string | null>,
  before: ReadonlyMap<string, string | null>,
  failed: ReadonlySet<string>,
  done: ReadonlySet<string>,
  behind: ReadonlyMap<string, string>
): Map<string, string | null> {
  const next = new Map<string, string | null>();
  for (const [id, cursor] of Array.from(from)) {
    if (failed.has(id) || !done.has(id)) next.set(id, cursor);
  }
  for (const id of Array.from(failed)) {
    if (!next.has(id) && before.has(id)) next.set(id, before.get(id)!);
  }
  for (const [id, cursor] of Array.from(behind)) {
    if (!failed.has(id)) next.set(id, cursor);
  }
  return next;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function emptyReport(mode: 'report' | 'write'): WavesChainMirrorReport {
  return {
    mode,
    height: null,
    network: null,
    events: 0,
    cursor: null,
    full: { running: false, started: null, completed: false, after: null },
    decisions: { mirrored: 0, unchanged: 0, skipped: {}, failed: 0, left: 0 },
    changes: {},
    waiting: {},
    notes: {},
    objects: null,
    invalidLegacyIds: 0,
    differences: []
  };
}

export const wavesChainMirror = new WavesChainMirror(
  wavesChainMirrorDb,
  // The index read from the writer too: its rows and log as committed.
  new WavesChainIndexDb(() => writerPoolExecutor),
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  new WavesChainObjectsMirror(
    wavesChainObjectsDb,
    (ids) => wavesChainMirrorDb.profilesOfPrincipals(ids),
    defaultObjectEffects,
    new ModerationContentGate(),
    () => Date.now()
  )
);
