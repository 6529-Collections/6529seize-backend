import { appFeatures } from '@/app-features';
import { readEnvelopeHead } from '@/chain-relay/chain-envelope';
import { CustomApiCompliantException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';
import {
  isWavesFrozen,
  isWavesSwitchedOn,
  WAVES_FROZEN_STATUS,
  WavesFrozenException
} from '@/waves-freeze/waves-freeze';
import { wavesScopeService } from '@/waves-scope/waves-scope.service';

/**
 * Polls made on the 6529 chain show on 6529.io only once the waves chain
 * mirror writes them into 6529.io's poll tables. Until then, from the
 * switch-on, 6529.io makes no new poll in a wave that moved to the chain,
 * and relays no POLL_CREATE, so no poll is made that 6529.io can't show.
 * FEATURE_WAVES_CHAIN_POLLS=true says the mirror's poll step is live, and
 * lifts both. A wave that stays on 6529.io takes polls as before.
 *
 * 6529.io can't stop a POLL_CREATE sent to the chain another way: to the
 * gateway's own POST /v1/submit, or to a node. Such a poll is on the chain
 * but not on 6529.io until the mirror's poll step is live.
 *
 * Same HTTP status as the waves freeze's refusals (423), with its own code.
 */
export const WAVES_POLLS_PAUSED_CODE = 'WAVES_POLLS_PAUSED';

export const WAVES_POLLS_PAUSED_MESSAGE =
  `New polls are paused in waves on the 6529 Network until 6529.io can ` +
  `show them. Waves that stay on 6529.io still take polls.`;

/** POLL_CREATE's operation code at rule version 7. */
export const POLL_CREATE_OP_TYPE = 0x0607;

export class WavesPollsPausedException extends CustomApiCompliantException {
  constructor() {
    super(
      WAVES_FROZEN_STATUS,
      WAVES_POLLS_PAUSED_MESSAGE,
      WAVES_POLLS_PAUSED_CODE
    );
  }
}

/**
 * Whether new polls in moved waves are paused now: waves have switched on
 * (WAVES_SWITCH_ON_AT or FEATURE_WAVES_ON_CHAIN), and
 * FEATURE_WAVES_CHAIN_POLLS is not on.
 */
export function isChainPollCreationPaused(
  nowMillis: number = Time.currentMillis()
): boolean {
  return isWavesSwitchedOn(nowMillis) && !appFeatures.isWavesChainPollsLive();
}

/**
 * Throws when 6529.io can't make a poll in this wave now. In a wave that
 * moves: WavesPollsPausedException while new polls are paused (from the
 * switch-on), else WavesFrozenException while waves are frozen. A wave that
 * stays passes. The wave's side is read once, from the primary or the
 * transaction's connection.
 */
export async function assertPollCreationOpen(
  waveId: string | null | undefined,
  ctx: RequestContext
): Promise<void> {
  const paused = isChainPollCreationPaused();
  if (!paused && !isWavesFrozen()) return;
  if (await wavesScopeService.waveStays(waveId, ctx)) return;
  if (paused) throw new WavesPollsPausedException();
  throw new WavesFrozenException();
}

/**
 * Throws WavesPollsPausedException for a POLL_CREATE (`unsigned` or
 * `signed` bytes, 0x hex) while new polls are paused. Every wave a
 * POLL_CREATE names is on the chain, so it is one that moved. Bytes that
 * are no transaction pass here; the chain refuses them.
 */
export function assertRelayedPollCreationOpen(hex: string): void {
  if (!isChainPollCreationPaused()) return;
  if (readEnvelopeHead(hex)?.opType === POLL_CREATE_OP_TYPE) {
    throw new WavesPollsPausedException();
  }
}
