import { Logger } from '@/logging';
import {
  CHAIN_ENTRY_HOLDS_TABLE,
  CHAIN_EVENTS_TABLE,
  WAVES_CHAIN_MIRROR_WAVES_TABLE
} from '@/constants';
import { chainGatewayClient } from '@/chain-gateway/chain-gateway.client';
import { SqlExecutor } from '@/sql-executor';
import { WavesChainIndexDb } from '@/waves-chain-index/waves-chain-index.db';
import { StoredDocuments } from './waves-chain-mirror.docs';
import { WavesChainMirrorDb } from './waves-chain-mirror.db';
import { ContentGate, GateVerdict } from './waves-chain-mirror.gate';
import { waveDescriptionDropId } from './waves-chain-mirror.ids';
import {
  ObjectEffects,
  WavesChainObjectsMirror
} from './waves-chain-mirror.objects';
import { WavesChainObjectsDb } from './waves-chain-mirror.objects.db';
import { defaultObjectEffects } from './waves-chain-mirror.objects.effects';
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
 *   score-refresh effects. Address-only identities are the identity
 *   area's: a group listing an address with none waits for them
 *   (group_address_identity_missing).
 * - Moderation is read from the holds the mirror kept (chain_entry_holds,
 *   waves_chain_mirror_waves), never asked again.
 * - Every id it writes comes from a chain id or a legacy id, except the
 *   auto-increment ones 6529.io's tables give: waves and drops serial_no,
 *   and competition_vote_history ids (and the score history sequences and
 *   mutation sequences made from them).
 */

/** What the rebuild check gives a rebuilder that the mirror reads. */
export interface MirrorRebuildContext {
  readonly mark?: { readonly chainHeight: number | null };
}

export interface MirrorRebuildResult {
  readonly runs: number;
  /** The chain time the rebuild wrote under (ms). */
  readonly at: number;
  readonly last: WavesChainMirrorReport;
}

/** Runs the mirror reads at most, before a rebuild gives up. */
const MAX_RUNS = 50;
const RUN_BUDGET_MS = 60_000;

/** The holds the mirror kept, as the rebuild's moderation reads them. */
export interface KeptHolds {
  /** An entry's hold reason and retry; null when it has none. */
  entryHold(
    entryId: string
  ): Promise<{ reason: string; retryAt: number | null } | null>;
  /** A wave's hold reason; null when it has none. */
  waveHold(waveId: string): Promise<string | null>;
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

  async waveHold(waveId: string) {
    const row = await this.db().oneOrNull<{ held: string | null }>(
      `select held from ${WAVES_CHAIN_MIRROR_WAVES_TABLE}
        where chain_wave_id = :waveId`,
      { waveId }
    );
    return row?.held ?? null;
  }
}

const REFUSED = 'moderation';
const DEFERRED = 'moderation_deferred';
const DESCRIPTION_REFUSED = 'description_moderation';
const DESCRIPTION_DEFERRED = 'description_moderation_deferred';

/**
 * Moderation as the live mirror left it: a kept refusal refuses, a kept
 * deferral defers, anything else is allowed. The evaluator is never asked.
 */
export class KeptHoldsGate implements ContentGate {
  constructor(private readonly holds: KeptHolds) {}

  async check(input: {
    readonly dropId: string;
    readonly waveId: string;
  }): Promise<GateVerdict> {
    if (input.dropId === waveDescriptionDropId(input.waveId)) {
      const held = await this.holds.waveHold(input.waveId);
      if (held === DESCRIPTION_REFUSED) return { kind: 'refused', code: held };
      if (held === DESCRIPTION_DEFERRED) {
        return { kind: 'deferred', code: held };
      }
      return { kind: 'allowed' };
    }
    const hold = await this.holds.entryHold(input.dropId);
    if (hold?.reason === REFUSED) return { kind: 'refused', code: REFUSED };
    if (hold?.reason === DEFERRED) return { kind: 'deferred', code: DEFERRED };
    return { kind: 'allowed' };
  }
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
export async function rebuildWavesChainMirror(
  _ctx: MirrorRebuildContext = {},
  db: () => SqlExecutor = () => writerPoolExecutor,
  env: NodeJS.ProcessEnv = process.env
): Promise<MirrorRebuildResult> {
  const index = new WavesChainIndexDb(db);
  const state = await index.loadState();
  if (state.feedNext === null || state.lastFullAt === null) {
    throw new Error('The chain index has no full read to rebuild from');
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
  const mirror = new WavesChainMirror(
    store,
    index,
    () => settings,
    clock,
    (keep) => new StoredDocuments(store, chainGatewayClient, keep),
    gate,
    undefined,
    undefined,
    new WavesChainObjectsMirror(
      new WavesChainObjectsDb(db, 'rebuild'),
      (ids) => store.profilesOfPrincipals(ids),
      rebuildObjectEffects,
      gate,
      clock
    )
  );
  let last: WavesChainMirrorReport | null = null;
  for (let run = 1; run <= MAX_RUNS; run++) {
    last = await mirror.run({ budgetMs: RUN_BUDGET_MS });
    if (last.mode === 'skipped') {
      throw new Error(`The mirror's rebuild was skipped: ${last.skipped}`);
    }
    logger.info(
      `[RUN ${run}] events ${last.events}, full ${JSON.stringify(last.full)}, decisions ${JSON.stringify(last.decisions)}`
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
          `The mirror's rebuild left ${failed} failure(s): ${JSON.stringify(last)}`
        );
      }
      return { runs: run, at, last };
    }
  }
  throw new Error(
    `The mirror's rebuild didn't finish in ${MAX_RUNS} runs: ${JSON.stringify(last)}`
  );
}
