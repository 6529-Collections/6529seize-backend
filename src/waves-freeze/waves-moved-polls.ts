import { CustomApiCompliantException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';
import {
  isWavesSwitchedOn,
  wavesFreezeAtMs
} from '@/waves-freeze/waves-freeze';
import { wavesScopeService } from '@/waves-scope/waves-scope.service';

/**
 * A poll still open at the waves freeze moves to the 6529 chain closed at
 * the freeze, with no ballots carried. From the switch-on 6529.io shows it
 * the same way: in a wave that moved, a poll made before the freeze whose
 * stored close time is after WAVES_FREEZE_AT reads as closed at
 * WAVES_FREEZE_AT, and takes no ballot. Its stored row is left as it is.
 *
 * - Made before the freeze: its drop's created_at is at or before the
 *   freeze. A poll the chain makes later is not touched.
 * - Before the switch-on nothing changes (the freeze already refuses votes
 *   in a moving wave). A wave that stays on 6529.io keeps its polls as
 *   they are. With no WAVES_FREEZE_AT time (FEATURE_WAVES_FROZEN alone)
 *   there is no time to close them at, and nothing changes.
 */
export const WAVES_POLL_CLOSED_AT_MOVE_CODE = 'WAVES_POLL_CLOSED_AT_MOVE';

export const WAVES_POLL_CLOSED_AT_MOVE_MESSAGE =
  'This poll closed when the wave moved to the 6529 Network.';

/** 400, as a ballot on any closed poll. */
export class WavesPollClosedAtMoveException extends CustomApiCompliantException {
  constructor() {
    super(
      400,
      WAVES_POLL_CLOSED_AT_MOVE_MESSAGE,
      WAVES_POLL_CLOSED_AT_MOVE_CODE
    );
  }
}

/** What a poll's close needs: its stored time and its drop's created_at. */
export interface PollTimes {
  readonly closing_time: number;
  /** The poll's drop's created_at; unknown counts as before the freeze. */
  readonly created_at?: number | null;
}

/**
 * The time polls in a moved wave close by: WAVES_FREEZE_AT once waves have
 * switched on; null before, or when WAVES_FREEZE_AT holds no time.
 */
export function movedPollsCloseAt(
  nowMillis: number = Time.currentMillis()
): number | null {
  return isWavesSwitchedOn(nowMillis) ? wavesFreezeAtMs() : null;
}

/** Whether a poll was made by `closesAt` and still open then. */
export function openAtMove(poll: PollTimes, closesAt: number): boolean {
  const made = poll.created_at;
  return (
    Number(poll.closing_time) > closesAt &&
    (made === undefined || made === null || Number(made) <= closesAt)
  );
}

/**
 * A poll as 6529.io shows it, `closesAt` being its wave's close time from
 * wavePollsCloseAt (null: as stored).
 */
export function pollAsShown<T extends PollTimes>(
  poll: T,
  closesAt: number | null
): T {
  return closesAt !== null && openAtMove(poll, closesAt)
    ? { ...poll, closing_time: closesAt }
    : poll;
}

/**
 * For one wave: the time its polls made before the freeze close by, or
 * null when it stays on 6529.io or waves haven't switched on. A display
 * read: the wave's side comes from the replica, kept for a minute.
 */
export async function wavePollsCloseAt(
  waveId: string,
  ctx: RequestContext
): Promise<number | null> {
  const closesAt = movedPollsCloseAt();
  if (closesAt === null) return null;
  const stays = await wavesScopeService.staysForDisplay([waveId], ctx);
  return stays.get(waveId) ? null : closesAt;
}

/**
 * Polls by drop id as 6529.io shows them: one still open at the freeze in
 * a moved wave closes at the freeze. Waves' sides are read (from the
 * replica, kept for a minute) only when there is such a poll.
 */
export async function withPollsClosedAtMove<
  T extends PollTimes & { readonly wave_id: string }
>(polls: Record<string, T>, ctx: RequestContext): Promise<Record<string, T>> {
  const closesAt = movedPollsCloseAt();
  if (closesAt === null) return polls;
  const open = Object.values(polls).filter((poll) =>
    openAtMove(poll, closesAt)
  );
  if (!open.length) return polls;
  const stays = await wavesScopeService.staysForDisplay(
    open.map((poll) => poll.wave_id),
    ctx
  );
  const shown: Record<string, T> = {};
  for (const [dropId, poll] of Object.entries(polls)) {
    shown[dropId] = stays.get(poll.wave_id)
      ? poll
      : pollAsShown(poll, closesAt);
  }
  return shown;
}

/**
 * Throws WavesPollClosedAtMoveException for a ballot on a poll still open
 * at the freeze in a moved wave, from the switch-on. The wave's side is
 * read from the primary, or the transaction's connection.
 */
export async function assertBallotNotClosedAtMove(
  poll: PollTimes & { readonly wave_id: string },
  ctx: RequestContext
): Promise<void> {
  const closesAt = movedPollsCloseAt();
  if (closesAt === null || !openAtMove(poll, closesAt)) return;
  if (await wavesScopeService.waveStays(poll.wave_id, ctx)) return;
  throw new WavesPollClosedAtMoveException();
}
