import { appFeatures } from '@/app-features';
import { IDENTITIES_TABLE } from '@/constants';
import {
  bytesMatchCid,
  ChainGatewayClient,
  chainGatewayClient,
  ChainGatewayError,
  cidHex,
  cidPath
} from '@/chain-gateway/chain-gateway.client';
import { Logger } from '@/logging';
import { RebuildContext } from '@/rebuild/manifest.types';
import { seedProbeIdentities } from '@/rebuild/run/probe-fixture.steps';
import { dbSupplier } from '@/sql-executor';
import {
  identityChainMirrorDb,
  IdentityChainMirrorDb,
  MirrorState
} from './identity-chain-mirror.db';
import {
  IdentityChainMirror,
  MirrorRunReport
} from './identity-chain-mirror.service';
import {
  fetchPlaceholdersFile,
  filesSourceUrl,
  FREEZE_PLACEHOLDERS_SHA256,
  PlaceholdersFileRef,
  readPlaceholdersFile,
  restoreUntakenPlaceholders,
  writePlaceholderList
} from './placeholder-restore';
import { PlaceholderAtFreezeLine } from './placeholders-at-freeze.format';
import {
  worldPlaceholdersFile,
  writePlaceholdersFixture
} from './rebuild-world/fixture-file';
import { plantPlaceholderReferences } from './rebuild-world/placeholder-references';
import {
  writeSiteRowsAfterSwitchOn,
  writeSiteRowsBeforeSwitchOn,
  writeWavesPeopleTdh
} from './rebuild-world/site-rows';
import {
  fetchSwitchOnRecord,
  loadSwitchOnRecord,
  SWITCH_ON_RECORD_PINS,
  takeSwitchOnRecord,
  writeSwitchOnRecordFixture
} from './switch-on-record';
import { formatTdhOnlyRecord } from './tdh-only-record';

/**
 * The identity area's steps of the rebuild check (docs/rebuild-check.md):
 * the identity mirror's own code, run from empty tables against the run's
 * gateway source until it has caught up with the chain at the mark.
 *
 * - `rebuildIdentityMirror` (rebuilder identity.chain-mirror) fills the
 *   tables the mirror writes from the switch-on record
 *   (switch-on-record.ts), the 6529 chain and the "placeholders at freeze"
 *   file (placeholder-restore.ts): first the record's rows, the ones with
 *   no handle and no chain identity whose random ids no rebuild derives,
 *   as 6529.io held them when the mirror first ran; then the file's
 *   placeholders as the list the mirror's first run would make from
 *   6529.io's profiles, the mirror run to the mark, then each placeholder
 *   no chain identity took, restored.
 * - `seedIdentityMirror` (seed identity.probe-profiles) puts the stack in
 *   its "before" state: 6529.io's rows from before switch-on that the
 *   chain doesn't hold, the switch-on record taken from them, the mirror
 *   run forward as the delegations loop runs it from switch-on, then
 *   6529.io's own writes that go on after it (rebuild-world/site-rows.ts),
 *   the placeholder profiles of the file among them. When the run's
 *   gateway serves no
 *   identity import (another area's run, with that area's own recording)
 *   it writes the world's actors as plain rows instead (the probes and the
 *   identities other areas' seeds read by wallet), as the harness's
 *   seed does.
 *
 * Both run the mirror without membership handlers: the holdings queue they
 * fill is the holdings loops' input, and the rebuild check rebuilds the
 * holdings tables from address_consolidation_keys itself. For the same
 * reason both take the wallets the mirror queued for re-keying off the
 * queue at the end (identity_chain_regroups), as the delegations loop does
 * once it has re-keyed them, without the re-keying: it rewrites the TDH,
 * holdings and subscriptions tables, which their own areas rebuild.
 */

const logger = Logger.get('IDENTITY_CHAIN_MIRROR_REBUILD');

/** One mirror run's time: the six minutes the delegations loop gives it. */
export const RUN_BUDGET_MS = 6 * 60 * 1000;
/** Runs before the step gives up on catching up. */
export const MAX_RUNS = 5;
/**
 * How far a run may go past its budget: the rating events get a minute at
 * least (the service's RATING_EVENTS_FLOOR_MS).
 */
const RUN_OVERRUN_MS = 60 * 1000;
/** The longest the catching-up runs of one step take. */
export const MIRROR_RUNS_AT_MOST_MS =
  MAX_RUNS * (RUN_BUDGET_MS + RUN_OVERRUN_MS);
/**
 * The identities rows one run's level walk covers: the service's 20
 * chunks a run (OFF_CHAIN_CHUNKS_A_RUN) of 1,000 keys each (the db's
 * fixLevelsOffTheChain chunk).
 */
export const OFF_CHAIN_ROWS_A_RUN = 20 * 1_000;
/**
 * One walk run's budget: once caught up, a run has only the walk to do,
 * and 20 chunks are 20 indexed reads and 20 range updates.
 */
export const WALK_RUN_BUDGET_MS = 60 * 1000;
/**
 * The walk runs' time: no run starts after it. An estimate of a few
 * seconds a run, not measured: 57 runs for 1.1M rows would take minutes.
 */
export const WALK_AT_MOST_MS = 10 * 60 * 1000;
/**
 * The longest mirrorToMark takes: the catching-up runs, then the walk
 * runs (the last may start just inside WALK_AT_MOST_MS and take its
 * budget and the overrun). Within both mirror steps' timeouts.
 */
export const MIRROR_AT_MOST_MS =
  MIRROR_RUNS_AT_MOST_MS +
  WALK_AT_MOST_MS +
  WALK_RUN_BUDGET_MS +
  RUN_OVERRUN_MS;
/** Regrouped wallets taken off the queue at a time. */
const REGROUPS_BATCH = 5_000;

type Gateway = ConstructorParameters<typeof IdentityChainMirror>[0] &
  Pick<ChainGatewayClient, 'getStatus' | 'getHead'>;

export interface MirrorToMarkDeps {
  readonly gateway: Gateway;
  readonly db: IdentityChainMirrorDb;
  readonly now: () => number;
  readonly env: Record<string, string | undefined>;
  readonly mirrorEnabled: () => boolean;
  readonly budgetMs: number;
  readonly maxRuns: number;
  /** The identities rows, which bound the level walk's runs. */
  readonly identitiesCount: () => Promise<number>;
}

async function countIdentities(): Promise<number> {
  const [row] = await dbSupplier().execute<{ n: number | string }>(
    `select count(*) as n from ${IDENTITIES_TABLE}`
  );
  return Number(row?.n ?? 0);
}

const DEFAULT_DEPS: MirrorToMarkDeps = {
  gateway: chainGatewayClient,
  db: identityChainMirrorDb,
  now: () => Date.now(),
  env: process.env,
  mirrorEnabled: () => appFeatures.isIdentityChainMirrorEnabled(),
  budgetMs: RUN_BUDGET_MS,
  maxRuns: MAX_RUNS,
  identitiesCount: countIdentities
};

export interface MirrorToMarkResult {
  /** The finalized height the mirror read to: the mark. */
  readonly height: number;
  /** Runs to catch up with the chain. */
  readonly runs: number;
  /** Runs after those, to finish the level walk. */
  readonly walkRuns: number;
  readonly last: MirrorRunReport;
  /** Regrouped wallets taken off the queue at the end. */
  readonly regroupsDrained: number;
}

/**
 * Takes every wallet the mirror queued for re-keying off the queue, with
 * the queue's own calls, as the delegations loop does after re-keying them
 * (rekeyRegroupedWallets), without the re-keying itself. A batch the same
 * as the one before (taken off and still there) fails, rather than loop.
 */
async function drainRegroups(
  mirror: Pick<
    IdentityChainMirror,
    'pendingRegroups' | 'regroupsStarted' | 'regroupsDone'
  >,
  now: () => number
): Promise<number> {
  let drained = 0;
  let previous = '';
  for (;;) {
    const before = now();
    const wallets = await mirror.pendingRegroups(REGROUPS_BATCH);
    if (!wallets.length) return drained;
    const batch = JSON.stringify(wallets);
    if (batch === previous) {
      throw new Error(
        `The regrouped wallets stay queued after they were taken off: ${wallets.slice(0, 5).join(', ')}`
      );
    }
    previous = batch;
    await mirror.regroupsStarted(wallets);
    await mirror.regroupsDone(wallets, before);
    drained += wallets.length;
  }
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/**
 * The run's gateway, as the mirror reads it: the manifest's flags set
 * CHAIN_GATEWAY_URL to the gateway source and turn the mirror on. Anything
 * else would read another chain than the run's, or none.
 */
function checkSettings(ctx: RebuildContext, deps: MirrorToMarkDeps): string {
  const source = ctx.sources.gateway;
  if (!source) {
    throw new Error(
      `${ctx.stepId} reads the 6529 chain: run it with --source gateway=<spec>`
    );
  }
  const configured = deps.env.CHAIN_GATEWAY_URL?.trim() ?? '';
  if (!sameUrl(configured, source)) {
    throw new Error(
      `${ctx.stepId}: CHAIN_GATEWAY_URL is not the run's gateway source (the identity manifest's flags set it to {gateway})`
    );
  }
  if (!deps.mirrorEnabled()) {
    throw new Error(
      `${ctx.stepId}: FEATURE_IDENTITY_CHAIN_MIRROR is off (the identity manifest's flags turn it on)`
    );
  }
  return source;
}

/**
 * The gateway as the rebuild steps give it to the mirror: the chain's reads
 * from the gateway source, and the profile documents from the files source
 * (`<files>/<b and the base32 CID>`), where the run keeps content-addressed
 * files. The gateway's document store is not a chain read, so a capture of
 * the chain does not hold it. Each document is checked against its CID, as
 * the gateway client checks the store's; one the files source doesn't hold
 * reads as none, which the mirror reports, and the files source counts the
 * missing file as a problem of the run.
 */
export function docsFromFiles<G extends Gateway>(
  gateway: G,
  filesUrl: string,
  fetchImpl: typeof fetch = fetch
): G {
  const document = async (cid: string): Promise<Buffer | null> => {
    const key = cidHex(cid);
    const response = await fetchImpl(filesSourceUrl(filesUrl, cidPath(key)));
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new Error(
        `The files source answered ${response.status} for document ${cidPath(key)}`
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytesMatchCid(key, bytes)) {
      throw new ChainGatewayError(
        `The files source's document ${cidPath(key)} does not match its CID`,
        200,
        'cid_mismatch',
        '/v1/docs'
      );
    }
    return bytes;
  };
  return new Proxy(gateway, {
    get(target, property) {
      if (property === 'getProfileDoc' || property === 'getDocument') {
        return document;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

/** The mirror's gateway for a step: documents from the run's files source. */
function stepDeps(ctx: RebuildContext): MirrorToMarkDeps {
  if (!ctx.sources.files) {
    throw new Error(
      `${ctx.stepId} reads the profile documents and the placeholder list from the files source: run it with --source files=<dir>`
    );
  }
  return {
    ...DEFAULT_DEPS,
    gateway: docsFromFiles(DEFAULT_DEPS.gateway, ctx.sources.files)
  };
}

/** Whether the gateway's chain has an identity import (its status says). */
export async function servesIdentityImport(
  gateway: Pick<ChainGatewayClient, 'getStatus'>
): Promise<boolean> {
  const status = (await gateway.getStatus()) as { import?: unknown };
  return !!status.import && typeof status.import === 'object';
}

function retryLeft(state: MirrorState): number {
  return (
    state.retry.principals.length +
    state.retry.targets.length +
    state.retry.wallets.length
  );
}

/**
 * The mirror is at `height` with nothing left: caught up with the chain
 * (caughtUpWithChain), and the walk that gives the rows off the chain a
 * level of REP + TDH has reached the end of the identities (its cursor
 * cleared). The full sync's own fix of those rows leaves out the rows of
 * identities waiting to be retried; the walk reaches them later, so until
 * it ends, such a row past the cursor keeps an older level.
 */
export function caughtUp(state: MirrorState | null, height: number): boolean {
  return caughtUpWithChain(state, height) && state!.off_chain_after === null;
}

/**
 * The mirror is at `height` with nothing left but the level walk: a full
 * sync ended and none is under way, the feed, the wallet bindings and the
 * rating events are past the height, no level sweep or ledger rebuild is
 * under way, and no key waits to be tried again. With no key waiting, each
 * run walks on (the service skips the walk only while keys wait).
 */
export function caughtUpWithChain(
  state: MirrorState | null,
  height: number
): boolean {
  if (!state) return false;
  const next = height + 1;
  return (
    state.sync_phase === null &&
    state.last_full_sync_at !== null &&
    state.next_height !== null &&
    Number(state.next_height) >= next &&
    state.bindings_next_height !== null &&
    Number(state.bindings_next_height) >= next &&
    state.events_next_height !== null &&
    Number(state.events_next_height) >= next &&
    state.events_rebuild_height === null &&
    state.level_sweep_day === null &&
    retryLeft(state) === 0
  );
}

function summary(report: MirrorRunReport): string {
  return JSON.stringify({
    mode: report.mode,
    identities: report.identities,
    ratingTargets: report.ratingTargets,
    delegationWallets: report.delegationWallets,
    walletBindings: report.walletBindings,
    ratingEvents: report.ratingEvents,
    levelsSwept: report.levelsSwept,
    nextHeight: report.nextHeight,
    eventsNextHeight: report.eventsNextHeight,
    bindingsNextHeight: report.bindingsNextHeight,
    retryLeft: report.retryLeft,
    failed: report.failed,
    skippedInactive: report.skippedInactive,
    skippedTooManyWallets: report.skippedTooManyWallets,
    docProblems: report.docProblems,
    bindingProblems: report.bindingProblems,
    ratingEventProblems: report.ratingEventProblems,
    orphanedProfiles: report.orphanedProfiles
  });
}

/**
 * Runs the identity mirror, as the delegations loop does, until it has
 * caught up with the gateway's finalized height, which must be the mark
 * (`ctx.mark.chainHeight`, when the run names one): the mirror reads the
 * chain at its finalized height, so a source past the mark would rebuild
 * past it. A recording stays at its height; a live devnet must be stopped
 * there. The height is read again at the end: a source that moved on
 * fails the step. Once caught up with the chain, it runs on until the
 * level walk has reached the end of the identities (finishLevelWalk).
 */
export async function mirrorToMark(
  ctx: RebuildContext,
  deps: MirrorToMarkDeps = DEFAULT_DEPS
): Promise<MirrorToMarkResult> {
  checkSettings(ctx, deps);
  if (!(await servesIdentityImport(deps.gateway))) {
    throw new Error(
      `${ctx.stepId}: the gateway source's chain has no identity import (its /v1/status has no import)`
    );
  }
  const height = (await deps.gateway.getHead(true)).finalizedHeight;
  const mark = ctx.mark.chainHeight;
  if (mark !== null && mark !== height) {
    throw new Error(
      `${ctx.stepId}: the gateway's finalized height is ${height}, not the mark ${mark}; the mirror reads at the finalized height, so the source must stop at the mark`
    );
  }
  logger.info(
    `[${ctx.stepId}] [MIRRORING TO HEIGHT ${height}]${mark === null ? ' [NO MARK GIVEN: THE SOURCE HEIGHT]' : ''}`
  );
  const mirror = new IdentityChainMirror(deps.gateway, deps.db, deps.now, []);
  for (let run = 1; run <= deps.maxRuns; run++) {
    const report = await mirror.run({ budgetMs: deps.budgetMs });
    logger.info(`[${ctx.stepId}] [RUN ${run}] ${summary(report)}`);
    checkRun(ctx, report);
    const state = await deps.db.getState();
    if (report.failed.length === 0 && caughtUpWithChain(state, height)) {
      const walk = await finishLevelWalk(ctx, deps, mirror, state!, height);
      const after = (await deps.gateway.getHead(true)).finalizedHeight;
      if (after !== height) {
        throw new Error(
          `${ctx.stepId}: the gateway moved from ${height} to ${after} during the rebuild`
        );
      }
      const regroupsDrained = await drainRegroups(mirror, deps.now);
      logger.info(
        `[${ctx.stepId}] [${regroupsDrained} REGROUPED WALLETS OFF THE QUEUE]`
      );
      return {
        height,
        runs: run,
        walkRuns: walk.runs,
        last: walk.last ?? report,
        regroupsDrained
      };
    }
  }
  throw new Error(
    `${ctx.stepId}: the mirror had not caught up with height ${height} after ${deps.maxRuns} runs`
  );
}

/** A run that skipped, stopped or found its rating events stuck fails the step. */
function checkRun(ctx: RebuildContext, report: MirrorRunReport): void {
  if (report.skipped) {
    throw new Error(`${ctx.stepId}: the mirror skipped: ${report.skipped}`);
  }
  if (report.error) {
    throw new Error(`${ctx.stepId}: the mirror stopped: ${report.error}`);
  }
  if (report.ratingEventsStuck) {
    throw new Error(`${ctx.stepId}: ${report.ratingEventsStuck}`);
  }
}

/**
 * Runs the mirror on, once caught up with the chain, until the walk that
 * gives the rows off the chain their level (REP + TDH) has reached the end
 * of the identities, as the delegations loop's runs do over time. Each run
 * walks OFF_CHAIN_ROWS_A_RUN rows, so the runs are held to
 * ceil(rows / OFF_CHAIN_ROWS_A_RUN) + 1 (the walk may start mid-table),
 * the rows counted once; each run must move the cursor (the walk only goes
 * forward, to the end, while no key waits), and none starts after
 * WALK_AT_MOST_MS. Every run's time is logged.
 */
async function finishLevelWalk(
  ctx: RebuildContext,
  deps: MirrorToMarkDeps,
  mirror: Pick<IdentityChainMirror, 'run'>,
  caught: MirrorState,
  height: number
): Promise<{ runs: number; last: MirrorRunReport | null }> {
  let cursor = caught.off_chain_after;
  if (cursor === null) return { runs: 0, last: null };
  const rows = await deps.identitiesCount();
  const cap = Math.ceil(rows / OFF_CHAIN_ROWS_A_RUN) + 1;
  logger.info(
    `[${ctx.stepId}] [LEVEL WALK UNFINISHED AT ${cursor}] [${rows} IDENTITIES ROWS] [AT MOST ${cap} RUNS, ${WALK_AT_MOST_MS / 60_000} MINUTES]`
  );
  const started = deps.now();
  for (let run = 1; run <= cap; run++) {
    if (deps.now() - started >= WALK_AT_MOST_MS) {
      throw new Error(
        `${ctx.stepId}: the level walk had not reached the end of the identities after ${WALK_AT_MOST_MS / 60_000} minutes (${run - 1} runs, at ${cursor})`
      );
    }
    const at = deps.now();
    const report = await mirror.run({ budgetMs: WALK_RUN_BUDGET_MS });
    checkRun(ctx, report);
    const state = await deps.db.getState();
    logger.info(
      `[${ctx.stepId}] [WALK RUN ${run}] [${deps.now() - at} MS] [CURSOR ${state?.off_chain_after ?? 'END'}]`
    );
    if (report.failed.length || !caughtUpWithChain(state, height)) {
      throw new Error(
        `${ctx.stepId}: walk run ${run} left the mirror behind the chain: ${summary(report)}`
      );
    }
    const next = state!.off_chain_after;
    if (next === null) return { runs: run, last: report };
    if (next === cursor) {
      throw new Error(
        `${ctx.stepId}: the level walk did not move past ${cursor} in walk run ${run}`
      );
    }
    cursor = next;
  }
  throw new Error(
    `${ctx.stepId}: the level walk had not reached the end of ${rows} identities rows after ${cap} runs (at ${cursor})`
  );
}

/**
 * The placeholders file the identity steps read: the freeze's once it is
 * pinned, else the world's fixture, which its code builds.
 */
export function placeholdersFile(): PlaceholdersFileRef {
  return FREEZE_PLACEHOLDERS_SHA256 !== null
    ? { sha256: FREEZE_PLACEHOLDERS_SHA256, fixture: false }
    : { sha256: worldPlaceholdersFile().sha256, fixture: true };
}

/**
 * Rebuilder identity.chain-mirror: the mirror's tables from the switch-on
 * record, the chain and the placeholders file. The record's rows go in
 * first, as 6529.io held them when the mirror first ran, so the mirror
 * adopts the same ids on equal keys; then the file's placeholders as the
 * mirror's placeholder list, so the founder rule takes the same ones; the
 * ones no chain identity took come back after the mirror has caught up.
 */
export async function rebuildIdentityMirror(
  ctx: RebuildContext
): Promise<void> {
  const deps = stepDeps(ctx);
  const { record, fixture } = await fetchSwitchOnRecord(ctx);
  const loaded = await loadSwitchOnRecord(record);
  logger.info(
    `[${ctx.stepId}] [SWITCH-ON RECORD LOADED] [${loaded.identities} IDENTITIES] [${loaded.keys} ADDRESS KEYS] [${fixture ? "THE REBUILD WORLD'S TAKE" : "THE TEAM'S TAKE"}]`
  );
  const file = placeholdersFile();
  const bytes = await fetchPlaceholdersFile(ctx, file);
  const header = await readPlaceholdersFile(bytes, file.sha256, (lines) =>
    writePlaceholderList(lines)
  );
  logger.info(
    `[${ctx.stepId}] [${header.count} PLACEHOLDER PROFILES LISTED FROM THE FILE] [FREEZE ${new Date(header.freeze_ms).toISOString()}] [TDH BLOCK ${header.tdh_block}] [${header.exporter_revision}]`
  );
  await mirrorToMark(ctx, deps);
  const counts = await restoreUntakenPlaceholders(bytes, file.sha256);
  logger.info(
    `[${ctx.stepId}] [PLACEHOLDERS RESTORED] ${JSON.stringify(counts)}`
  );
}

/** Every line of the placeholders file (the world's fixture: a few). */
async function placeholderLines(
  ctx: RebuildContext,
  file: PlaceholdersFileRef
): Promise<PlaceholderAtFreezeLine[]> {
  const bytes = await fetchPlaceholdersFile(ctx, file);
  const lines: PlaceholderAtFreezeLine[] = [];
  await readPlaceholdersFile(bytes, file.sha256, async (batch) => {
    lines.push(...batch);
  });
  return lines;
}

/** Whether the run's gateway is the identity world: it serves an import. */
async function identityWorldServed(ctx: RebuildContext): Promise<boolean> {
  return (
    !!ctx.sources.gateway && (await servesIdentityImport(chainGatewayClient))
  );
}

/**
 * Seed identity.probe-profiles: 6529.io's rows from before switch-on, the
 * mirror run forward to the mark (so the world's actors, the probes among
 * them, have their profiles from the chain), then 6529.io's writes after
 * it. Without a gateway that serves an identity import, the actors as
 * plain rows (another area's run, which keeps the identity tables).
 */
export async function seedIdentityMirror(ctx: RebuildContext): Promise<void> {
  if (!(await identityWorldServed(ctx))) {
    logger.warn(
      `[${ctx.stepId}] [NO GATEWAY WITH AN IDENTITY IMPORT] [THE WORLD'S ACTORS AS PLAIN ROWS]`
    );
    await seedProbeIdentities();
    return;
  }
  const deps = stepDeps(ctx);
  const file = placeholdersFile();
  // The world's placeholders file, which the freeze writes in production,
  // into the run's seed files for both steps to read. Not on a final run,
  // which takes the freeze's file and refuses the fixture.
  if (file.fixture && !ctx.final) {
    if (!ctx.seedFilesDir) {
      throw new Error(
        `${ctx.stepId} writes the world's placeholders file into the run's seed files: run it with --source files=<dir>`
      );
    }
    writePlaceholdersFixture(ctx.seedFilesDir);
  }
  await writeSiteRowsBeforeSwitchOn(await placeholderLines(ctx, file));
  // The switch-on record, taken where the team takes it: after 6529.io's
  // last writes before switch-on, right before the mirror's first run. The
  // rebuilder loads it first. A final run reads the team's take instead.
  if (SWITCH_ON_RECORD_PINS === null && !ctx.final) {
    if (!ctx.seedFilesDir) {
      throw new Error(
        `${ctx.stepId} writes the switch-on record into the run's seed files: run it with --source files=<dir>`
      );
    }
    const taken = await takeSwitchOnRecord();
    const pins = writeSwitchOnRecordFixture(
      ctx.seedFilesDir,
      formatTdhOnlyRecord(taken.rows, taken.keys)
    );
    logger.info(
      `[${ctx.stepId}] [SWITCH-ON RECORD TAKEN] [${taken.rows.length} IDENTITIES] [${taken.keys.length} ADDRESS KEYS] [${pins.identitiesSha256}] [${pins.keysSha256}]`
    );
  }
  await mirrorToMark(ctx, deps);
  await writeSiteRowsAfterSwitchOn();
  const people = await writeWavesPeopleTdh();
  logger.info(
    people
      ? `[${ctx.stepId}] [TDH WRITTEN FOR ${people} OF THE WAVES WORLD'S PEOPLE]`
      : `[${ctx.stepId}] [NO WAVES WORLD PEOPLE IN THIS RECORDING] [NO TDH WRITTEN FOR THEM]`
  );
}

/**
 * Seed identity.placeholder-references: one reference of each kind to the
 * world's untaken placeholder (rebuild-world/placeholder-references.ts),
 * in the tables that hold them, so the probes see the restored profile
 * found through them. Only with the identity world: without it there is no
 * such placeholder, and the rows would only stand in other areas' way.
 */
export async function seedPlaceholderReferences(
  ctx: RebuildContext
): Promise<void> {
  if (!(await identityWorldServed(ctx))) {
    logger.warn(`[${ctx.stepId}] [NO IDENTITY WORLD] [NO REFERENCES PLANTED]`);
    return;
  }
  const planted = await plantPlaceholderReferences();
  logger.info(`[${ctx.stepId}] [${planted} PLACEHOLDER REFERENCES PLANTED]`);
}
