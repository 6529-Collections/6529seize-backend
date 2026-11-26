import { CustomApiCompliantException } from '@/exceptions';
import { wavesSwitchedOn } from '@/waves-freeze/waves-switch-on';
import { EnvelopeHead } from './chain-envelope';

/**
 * The modules of the waves operations, an operation's module being its
 * opType's high byte: groups and roles (0x04), waves (0x05), and decisions,
 * pauses, entries, votes, polls and ballots (0x06). Every operation of
 * these modules opens with the waves, at the switch-on.
 *
 * RATING_SET (0x0701, the ratings module) is not one: it also carries
 * identity REP and NIC, which opened before the waves. Wave REP through it
 * is left to the chain.
 */
export const WAVES_OP_MODULES: ReadonlySet<number> = new Set([
  0x04, 0x05, 0x06
]);

/** Whether an operation code is a waves operation (WAVES_OP_MODULES). */
export function isWavesOperation(opType: number): boolean {
  return WAVES_OP_MODULES.has(opType >> 8);
}

export const WAVES_NOT_SWITCHED_ON_CODE = 'WAVES_NOT_SWITCHED_ON';

export const WAVES_NOT_SWITCHED_ON_MESSAGE =
  'Waves writes open on the 6529 Network at the switch-on.';

/** The waves freeze's 423, with its own code and one message. */
export class WavesNotSwitchedOnException extends CustomApiCompliantException {
  constructor() {
    super(423, WAVES_NOT_SWITCHED_ON_MESSAGE, WAVES_NOT_SWITCHED_ON_CODE);
  }
}

/**
 * Throws WavesNotSwitchedOnException for a waves operation before the
 * switch-on (WAVES_SWITCH_ON_AT or FEATURE_WAVES_ON_CHAIN, read now). Any
 * other operation passes, and so do bytes whose head can't be read: the
 * chain refuses those.
 */
export function assertWavesOperationOpen(
  head: EnvelopeHead | null,
  nowMillis: number
): void {
  if (head && isWavesOperation(head.opType) && !wavesSwitchedOn(nowMillis)) {
    throw new WavesNotSwitchedOnException();
  }
}
