import { RequestContext } from '@/request.context';
import {
  FreezeDecisionRef,
  isDecisionFrozen,
  isWavesFrozen,
  WAVES_FROZEN_MESSAGE,
  WavesFrozenException
} from '@/waves-freeze/waves-freeze';
import { wavesScopeService } from '@/waves-scope/waves-scope.service';

/**
 * The waves freeze holds only what moves to the 6529 chain: waves that move,
 * their decisions, entries, votes, wave REP and polls, and groups a wave
 * that moves uses. Waves that stay on 6529.io (src/waves-scope/waves-scope.ts
 * holds the rule) keep working through the freeze and after.
 *
 * Each check reads from the primary, or from the transaction's connection
 * when there is one. Run again inside the transaction after the write, the
 * same check sees the write, so it also refuses a write that would make a
 * staying wave move, or make a group a moving wave uses: such a wave would
 * have changed after the freeze, and the chain does not hold it.
 */

/** The wave a decision belongs to (a migrated one also names its legacy wave). */
export function decisionWaveId(decision: FreezeDecisionRef): string | null {
  return decision.wave_id ?? decision.legacy_wave_id ?? null;
}

/** Whether the freeze holds this wave now: waves are frozen and it moves. */
export async function isWaveFrozen(
  waveId: string | null | undefined,
  ctx: RequestContext
): Promise<boolean> {
  if (!isWavesFrozen()) return false;
  return !(await wavesScopeService.waveStays(waveId, ctx));
}

/**
 * Throws WavesFrozenException when the freeze holds this wave: waves are
 * frozen and the wave moves. A wave that stays on 6529.io passes.
 */
export async function assertWaveWritable(
  waveId: string | null | undefined,
  ctx: RequestContext,
  message: string = WAVES_FROZEN_MESSAGE
): Promise<void> {
  if (await isWaveFrozen(waveId, ctx)) {
    throw new WavesFrozenException(message);
  }
}

/**
 * Whether the freeze holds this decision now: waves are frozen, the freeze
 * does not keep it running (the Main Stage with
 * FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE), and its wave moves.
 */
export async function isDecisionFrozenNow(
  decision: FreezeDecisionRef,
  ctx: RequestContext
): Promise<boolean> {
  if (!isDecisionFrozen(decision)) return false;
  return !(await wavesScopeService.waveStays(decisionWaveId(decision), ctx));
}

/**
 * Throws WavesFrozenException when the freeze holds this decision: its
 * entries, votes, pauses, edits and actions are refused. A decision of a
 * wave that stays on 6529.io passes.
 */
export async function assertDecisionWritable(
  decision: FreezeDecisionRef,
  ctx: RequestContext,
  message: string = WAVES_FROZEN_MESSAGE
): Promise<void> {
  if (await isDecisionFrozenNow(decision, ctx)) {
    throw new WavesFrozenException(message);
  }
}

/**
 * For entries of decisions, each checked against its own decision (so the
 * Main Stage's entries pass when the freeze keeps the Main Stage running,
 * even in a wave with other decisions): throws WavesFrozenException when
 * the freeze holds any of them.
 */
export async function assertEntriesWritable(
  entries: readonly {
    readonly competition_id: string;
    readonly wave_id: string;
  }[],
  ctx: RequestContext,
  message: string = WAVES_FROZEN_MESSAGE
): Promise<void> {
  if (!isWavesFrozen() || !entries.length) return;
  const refs = await wavesScopeService.decisionRefs(
    entries.map((entry) => entry.competition_id),
    ctx
  );
  for (const entry of entries) {
    await assertDecisionWritable(
      refs.get(entry.competition_id) ?? { wave_id: entry.wave_id },
      ctx,
      message
    );
  }
}

/**
 * Throws WavesFrozenException while waves are frozen: no new wave (other
 * than a direct message, which callers leave out) is made here then. A
 * wave made after the freeze would stay on 6529.io (created_after_freeze),
 * but the freeze refuses new waves all the same.
 * Callers run it before any work and again right before the wave's row is
 * written.
 */
export function assertWaveCreationOpen(
  message: string = WAVES_FROZEN_MESSAGE
): void {
  if (isWavesFrozen()) {
    throw new WavesFrozenException(message);
  }
}

/**
 * Whether the freeze holds any of these groups: waves are frozen and a wave
 * that moves uses one of them. A group only staying waves use is open. Run
 * again after the write, inside its transaction, it also catches a change
 * that makes a staying wave that uses the group move.
 */
export async function isAnyGroupFrozen(
  groupIds: readonly (string | null | undefined)[],
  ctx: RequestContext
): Promise<boolean> {
  if (!isWavesFrozen()) return false;
  return wavesScopeService.usedByMovingWave(
    groupIds.filter((id): id is string => !!id),
    ctx
  );
}

/**
 * While waves are frozen, runs `write` and then refuses it (by throwing, so
 * the caller's transaction rolls back) when it changed whether the wave
 * stays on 6529.io. For writes the freeze otherwise leaves open on any wave,
 * such as curation groups: a wave that moves can't be made to stay, nor a
 * staying wave to move. `ctx` must carry the transaction's connection.
 */
export async function keepingWaveScope<T>(
  waveId: string,
  ctx: RequestContext,
  write: () => Promise<T>,
  message: string = WAVES_FROZEN_MESSAGE
): Promise<T> {
  if (!isWavesFrozen()) return write();
  const before = await wavesScopeService.waveStays(waveId, ctx);
  const result = await write();
  if ((await wavesScopeService.waveStays(waveId, ctx)) !== before) {
    throw new WavesFrozenException(message);
  }
  return result;
}
