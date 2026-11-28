import { Logger } from '@/logging';
import { CHAIN_ENTRY_HOLDS_TABLE, CHAIN_EVENTS_TABLE } from '@/constants';
import {
  bytesMatchCid,
  ChainGatewayClient,
  cidHex,
  cidPath
} from '@/chain-gateway/chain-gateway.client';
import { SqlExecutor } from '@/sql-executor';
import { WavesChainIndexDb } from '@/waves-chain-index/waves-chain-index.db';
import { StoredDocuments } from './waves-chain-mirror.docs';
import { WavesChainMirrorDb } from './waves-chain-mirror.db';
import { ContentGate, GateVerdict } from './waves-chain-mirror.gate';
import { InvalidLegacyIds } from './waves-chain-mirror.ids';
import { DropArchivesImport } from './waves-chain-mirror.legacy-rows';
import {
  ObjectEffects,
  WavesChainObjectsMirror
} from './waves-chain-mirror.objects';
import { WavesChainObjectsDb } from './waves-chain-mirror.objects.db';
import { defaultObjectEffects } from './waves-chain-mirror.objects.effects';
import {
  DESCRIPTION_DEFERRED,
  DESCRIPTION_REFUSED
} from './waves-chain-mirror.waves';
import {
  mirrorSettingsFromEnv,
  WavesChainMirror,
  WavesChainMirrorReport
} from './waves-chain-mirror.service';
import { writerPoolExecutor } from './waves-chain-mirror.writer';

const logger = Logger.get('WAVES_CHAIN_MIRROR_REBUILD');

/**
 * The mirror's rebuild: its rows made again from the chain index alone, as
 * the live mirror makes them, for the rebuild check.
 *
 * - The clock is the chain's: the time of the index's last applied block
 *   (the newest block time its event log holds), so two rebuilds of one
 *   index write the same times.
 * - It writes only the rows the mirror owns (6529.io's competition, wave,
 *   drop and group rows it mirrors, and its own tables): no outbox events,
 *   no claim builds, no artwork collaborations or their invitations, no
 *   collaboration freeze, no follows or activity, no
 *   voters' profile activity logs, no group change log, no socket or
 *   score-refresh effects. A group listing addresses waits, as live, until
 *   the identity mirror's rebuild stands at the group's height
 *   (group_identity_rows_not_reached), then gives an address still
 *   without an identity its address-only row as live does: from switch-on
 *   its derived id, so the rebuild gives the id live gave. Its lists are
 *   resolved once, to the identities the addresses belong to at the mark;
 *   the live mirror resolves its lists again each run as wallets move, so
 *   it holds the same lists once its identity mirror stands there too. A
 *   wallet that left an identity has the row the identity mirror's rebuild
 *   gives it, by the removal's block time, as live.
 * - Moderation is read from the holds the live mirror kept in
 *   chain_entry_holds (entries' and wave descriptions'), never asked again;
 *   a rebuild never writes them.
 * - Documents (wave, decision and outcome documents, entry manifests) come
 *   from the run's files source, never the gateway's document store: a
 *   capture of the chain doesn't hold that store. One the files source
 *   doesn't hold leaves its object waiting with its reason, counted; any
 *   other failure to read one fails the rebuild.
 * - The imported objects 6529.io has no row of (its tables dropped for the
 *   rebuild) get the rows 6529.io held of them, from the chain, their
 *   documents and their legacy ids (waves-chain-mirror.legacy-rows.ts,
 *   with what the chain can't give in mirrorPlannedRows).
 * - An object whose legacy id isn't an RFC 4122 UUID is left out, logged
 *   and counted, and the rest rebuilt; then the rebuild fails, naming the
 *   first of them.
 * - Every id it writes comes from a chain id or a legacy id, except the
 *   auto-increment ones 6529.io's tables give: waves and drops serial_no,
 *   and competition_vote_history ids (and the score history sequences and
 *   mutation sequences made from them).
 */

/** What the rebuild check gives a rebuilder that the mirror reads. */
export interface MirrorRebuildContext {
  readonly stepId?: string;
  /**
   * The run's sources, both required: `files` serves documents by CID;
   * `gateway` is the chain the mirror's gateway reads must read
   * (CHAIN_GATEWAY_URL).
   */
  readonly sources?: {
    readonly files?: string | null;
    readonly gateway?: string | null;
  };
  readonly mark?: { readonly chainHeight: number | null };
}

export interface MirrorRebuildResult {
  readonly runs: number;
  /** The chain time the rebuild wrote under (ms). */
  readonly at: number;
  readonly last: WavesChainMirrorReport;
  /**
   * Documents the files source doesn't hold: each one's object waits,
   * counted in the report.
   */
  readonly missingDocuments: number;
  /** What deps.importDropArchives gave; undefined without one. */
  readonly dropArchives?: DropArchivesImport;
}

/** What a rebuild reads besides the database (a test gives its own). */
export interface MirrorRebuildDeps {
  readonly fetchImpl?: typeof fetch;
  /**
   * A step run first, before the mirror writes anything: the rebuild
   * check's import of the drop archives (the drops from before the switch,
   * the import-files reader's), given the run's sources and its mark's
   * chain height (null without a mark), so it reads the chain's import at
   * the height the rest of the run reads. The mirror clears no table, so
   * its rows stay. Imported waves take their description drop
   * ids from its result; without it they get '' (planned, and 6529.io's
   * wave reads fail for them until the reader's step runs).
   */
  readonly importDropArchives?: (
    sources: { readonly files: string; readonly gateway: string },
    db: () => SqlExecutor,
    height: number | null
  ) => Promise<DropArchivesImport>;
}

/** Runs the mirror reads at most, before a rebuild gives up. */
const MAX_RUNS = 50;
const RUN_BUDGET_MS = 60_000;

/** The holds the mirror kept, as the rebuild's moderation reads them. */
export interface KeptHolds {
  /**
   * The hold reason and retry of an entry, or of a wave's description (by
   * its description drop id); null when it has none.
   */
  entryHold(
    entryId: string
  ): Promise<{ reason: string; retryAt: number | null } | null>;
}

export class KeptHoldsDb implements KeptHolds {
  constructor(private readonly db: () => SqlExecutor) {}

  async entryHold(entryId: string) {
    const row = await this.db().oneOrNull<{
      reason: string;
      retry_at: number | string | null;
    }>(
      `select reason, retry_at from ${CHAIN_ENTRY_HOLDS_TABLE}
        where entry_id = :entryId`,
      { entryId }
    );
    return row
      ? {
          reason: row.reason,
          retryAt: row.retry_at === null ? null : Number(row.retry_at)
        }
      : null;
  }
}

/** Moderation's holds: an entry's, and a wave description's. */
const REFUSALS = new Set(['moderation', DESCRIPTION_REFUSED]);
const DEFERRALS = new Set(['moderation_deferred', DESCRIPTION_DEFERRED]);

/**
 * Moderation as the live mirror left it: a kept refusal refuses, a kept
 * deferral defers, anything else is allowed. The evaluator is never asked.
 */
export class KeptHoldsGate implements ContentGate {
  constructor(private readonly holds: KeptHolds) {}

  async check(input: { readonly dropId: string }): Promise<GateVerdict> {
    const hold = await this.holds.entryHold(input.dropId);
    if (hold && REFUSALS.has(hold.reason)) {
      return { kind: 'refused', code: hold.reason };
    }
    if (hold && DEFERRALS.has(hold.reason)) {
      return { kind: 'deferred', code: hold.reason };
    }
    return { kind: 'allowed' };
  }
}

/**
 * Documents from the run's files source (`<files>/<b and the base32 CID>`),
 * as the identity area's rebuild reads them (docsFromFiles), each checked
 * against its CID; nothing is asked of the network.
 *
 * - One the files source doesn't hold (404) reads as none: its object
 *   waits, and it is counted.
 * - Any other answer, a failed read or bytes that don't match the CID
 *   throw, and are kept: the rebuild fails at the end of that run (the
 *   mirror's own reads take a throw as a missing document).
 */
export class FilesDocuments implements Pick<ChainGatewayClient, 'getDocument'> {
  /** The CIDs (hex) the files source doesn't hold. */
  readonly missing = new Set<string>();
  /** The documents the files source failed to give, with why. */
  readonly failures = new Map<string, string>();
  private readonly base: string;

  constructor(
    filesUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.base = filesUrl.replace(/\/+$/, '');
  }

  async getDocument(cid: string): Promise<Buffer | null> {
    const key = cidHex(cid);
    const name = cidPath(key);
    let problem: string;
    try {
      const response = await this.fetchImpl(`${this.base}/${name}`);
      if (response.status === 404) {
        if (!this.missing.has(key)) {
          logger.warn(`[DOCUMENTS] the files source has no ${name}`);
        }
        this.missing.add(key);
        return null;
      }
      if (response.status === 200) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytesMatchCid(key, bytes)) return bytes;
        problem = `The files source's document ${name} does not match its CID`;
      } else {
        problem = `The files source answered ${response.status} for document ${name}`;
      }
    } catch (error) {
      problem = `The files source's document ${name} was not read: ${error}`;
    }
    this.failures.set(key, problem);
    throw new Error(problem);
  }
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/**
 * The run's files source, for documents; and its gateway source, which the
 * mirror's gateway reads (block times, a decision's first policy) must
 * read: CHAIN_GATEWAY_URL is it.
 */
function sourcesOf(
  ctx: MirrorRebuildContext,
  env: NodeJS.ProcessEnv
): { files: string; gateway: string } {
  const step = ctx.stepId ?? 'The waves chain mirror';
  const gateway = ctx.sources?.gateway;
  if (!gateway) {
    throw new Error(
      `${step} reads the 6529 chain: run it with --source gateway=<spec>`
    );
  }
  if (!sameUrl(env.CHAIN_GATEWAY_URL?.trim() ?? '', gateway)) {
    throw new Error(
      `${step}: CHAIN_GATEWAY_URL is not the run's gateway source`
    );
  }
  const files = ctx.sources?.files;
  if (!files) {
    throw new Error(
      `${step} reads the chain's documents from the files source: run it with --source files=<dir>`
    );
  }
  return { files, gateway };
}

/** The effects of a rebuild: 6529.io's reads, and no effects of its own. */
export const rebuildObjectEffects: ObjectEffects = {
  ...defaultObjectEffects,
  groupsChanged: async () => undefined,
  waveChanged: async () => undefined
};

/**
 * The chain's time at the index's last applied block: the newest block
 * time its event log holds at or below it. Null when the log has none.
 */
export async function chainTimeOf(
  db: () => SqlExecutor,
  appliedHeight: number
): Promise<number | null> {
  const row = await db().oneOrNull<{ t: number | string | null }>(
    `select block_time as t from ${CHAIN_EVENTS_TABLE}
      where height <= :appliedHeight
      order by height desc, seq desc
      limit 1`,
    { appliedHeight }
  );
  return row?.t === null || row?.t === undefined ? null : Number(row.t);
}

/**
 * Rebuilds the mirror's rows from the chain index as it stands: runs the
 * mirror in rebuild mode until it has read the whole log and finished a
 * full pass over every decision. The index must be built first (to the
 * rebuild's mark, if any).
 */
export function rebuildWavesChainMirror(
  ctx: MirrorRebuildContext,
  db: () => SqlExecutor = () => writerPoolExecutor,
  env: NodeJS.ProcessEnv = process.env,
  deps: MirrorRebuildDeps = {}
): Promise<MirrorRebuildResult> {
  return mirrorFromIndex('rebuild', ctx, db, env, deps);
}

/**
 * The rebuild check's seed of the mirror's rows (its first pass, after the
 * chain index's seed): the rebuild's own run, so the rows the seed leaves
 * are the ones a rebuild must give again. It reads and writes what the
 * rebuild does, chain_entry_holds as seeded included (read only).
 */
export function seedWavesChainMirror(
  ctx: MirrorRebuildContext,
  db: () => SqlExecutor = () => writerPoolExecutor,
  env: NodeJS.ProcessEnv = process.env,
  deps: MirrorRebuildDeps = {}
): Promise<MirrorRebuildResult> {
  return mirrorFromIndex('seed', ctx, db, env, deps);
}

async function mirrorFromIndex(
  pass: 'rebuild' | 'seed',
  ctx: MirrorRebuildContext,
  db: () => SqlExecutor,
  env: NodeJS.ProcessEnv,
  deps: MirrorRebuildDeps
): Promise<MirrorRebuildResult> {
  const sources = sourcesOf(ctx, env);
  // The drop archives first, before the mirror writes anything.
  const dropArchives = deps.importDropArchives
    ? await deps.importDropArchives(sources, db, ctx.mark?.chainHeight ?? null)
    : undefined;
  const files = new FilesDocuments(sources.files, deps.fetchImpl);
  const index = new WavesChainIndexDb(db);
  const state = await index.loadState();
  if (state.feedNext === null || state.lastFullAt === null) {
    throw new Error(`The chain index has no full read to ${pass} from`);
  }
  const at = await chainTimeOf(db, state.feedNext - 1);
  if (at === null) throw new Error('The chain index has no block time');
  const clock = () => at;
  const store = new WavesChainMirrorDb(db, 'rebuild');
  const gate = new KeptHoldsGate(new KeptHoldsDb(db));
  const settings = {
    ...mirrorSettingsFromEnv(env, at),
    write: true,
    frozen: true
  };
  // The rebuild check resets the step's tables first (this mirror's state
  // among them), so the run makes a full pass over every decision: the
  // count of objects left out sees them all.
  const legacyIds = new InvalidLegacyIds((message) =>
    logger.warn(`[${pass.toUpperCase()}] ${message}`)
  );
  const mirror = new WavesChainMirror(
    store,
    index,
    () => settings,
    clock,
    (keep) => new StoredDocuments(store, files, keep),
    gate,
    undefined,
    undefined,
    new WavesChainObjectsMirror(
      new WavesChainObjectsDb(
        db,
        'rebuild',
        dropArchives
          ? {
              descriptionDropIds: new Map(
                Array.from(dropArchives.descriptionDropIds).map(
                  ([wave, drop]) => [wave.toLowerCase(), drop]
                )
              )
            }
          : null
      ),
      (ids) => store.profilesOfPrincipals(ids),
      rebuildObjectEffects,
      gate,
      clock
    ),
    undefined,
    legacyIds
  );
  let last: WavesChainMirrorReport | null = null;
  for (let run = 1; run <= MAX_RUNS; run++) {
    last = await mirror.run({ budgetMs: RUN_BUDGET_MS });
    if (last.mode === 'skipped') {
      throw new Error(`The mirror's ${pass} was skipped: ${last.skipped}`);
    }
    if (files.failures.size) {
      throw new Error(
        `The files source failed for ${files.failures.size} document(s): ${Array.from(files.failures.values()).slice(0, 5).join('; ')}`
      );
    }
    logger.info(
      `[${pass.toUpperCase()} RUN ${run}] events ${last.events}, full ${JSON.stringify(last.full)}, decisions ${JSON.stringify(last.decisions)}`
    );
    // Done when the log is read to its end, no full pass is under way
    // and nothing failed.
    if (!last.full.running && last.events === 0 && !last.decisions.left) {
      const failed =
        last.decisions.failed +
        (last.objects?.groups.failed ?? 0) +
        (last.objects?.waves.failed ?? 0) +
        (last.objects?.decisions.failed ?? 0);
      if (failed) {
        throw new Error(
          `The mirror's ${pass} left ${failed} failure(s): ${JSON.stringify(last)}`
        );
      }
      // Left out, the rest rebuilt: the rebuild fails once its pass is done.
      if (legacyIds.count) {
        throw new Error(
          `The mirror's ${pass} left out ${legacyIds.count} object(s) whose legacy id isn't an RFC 4122 UUID: ${legacyIds.first(5).join(', ')}`
        );
      }
      return {
        runs: run,
        at,
        last,
        missingDocuments: files.missing.size,
        ...(deps.importDropArchives ? { dropArchives } : {})
      };
    }
  }
  throw new Error(
    `The mirror's ${pass} didn't finish in ${MAX_RUNS} runs: ${JSON.stringify(last)}`
  );
}
