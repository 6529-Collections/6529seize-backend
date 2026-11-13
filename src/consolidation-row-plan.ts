import {
  Consolidation,
  ConsolidationEvent,
  EventType
} from './entities/IDelegation';

export interface ConsolidationRowPlan {
  readonly remove: Consolidation[];
  readonly save: Consolidation[];
}

/**
 * Works out how one register or revoke event changes the stored row for a
 * wallet pair.
 *
 * A pair has at most one row, stored as (first registrant, second
 * registrant). An unconfirmed row holds the one direction that is registered;
 * a confirmed row means both directions are. `sameDirection` is the row stored
 * as (event.wallet1, event.wallet2) and `reverseDirection` the row stored the
 * other way round; at most one of them exists.
 *
 * wallet1_registered_at / wallet2_registered_at follow the wallets they are
 * named after and record the block time of that wallet's latest registration.
 */
export function planConsolidationEvent(
  event: ConsolidationEvent,
  sameDirection: Consolidation | null,
  reverseDirection: Consolidation | null
): ConsolidationRowPlan {
  if (event.type === EventType.REGISTER) {
    return planRegistration(event, sameDirection, reverseDirection);
  }
  return planRevocation(event, sameDirection, reverseDirection);
}

/**
 * Prepares a row for replaying events from a reset block (the
 * DELEGATIONS_RESET_BLOCK path). Only rows last changed at or after the reset
 * block are passed in. Each live direction's state comes from its latest
 * registration, so directions registered at or after the reset block's time
 * are dropped (the replay adds them back) and older ones are kept. Replaying
 * the events from the reset block onto the result gives the same live links,
 * with the same registration times, as a full replay. (A pair whose direction
 * was registered again after the reset block is ordered by that later
 * registration.) A direction with no recorded time was registered before times
 * were tracked, so it is kept.
 */
export function planConsolidationRewind(
  row: Consolidation,
  resetBlockTimestamp: number
): ConsolidationRowPlan {
  const isKept = (registeredAt: number | null) =>
    registeredAt === null || Number(registeredAt) < resetBlockTimestamp;
  const keepFirst = isKept(row.wallet1_registered_at);
  const keepSecond = row.confirmed && isKept(row.wallet2_registered_at);
  if (keepFirst && (keepSecond || !row.confirmed)) {
    return { remove: [], save: [] };
  }
  if (!keepFirst && !keepSecond) {
    return { remove: [row], save: [] };
  }
  // Exactly one direction of a confirmed row is kept: it stays as a one-way
  // row registered by that wallet.
  const [wallet1, wallet2, registeredAt] = keepFirst
    ? [row.wallet1, row.wallet2, row.wallet1_registered_at]
    : [row.wallet2, row.wallet1, row.wallet2_registered_at];
  return {
    remove: [row],
    save: [
      newRow({
        block: row.block,
        wallet1,
        wallet2,
        confirmed: false,
        wallet1RegisteredAt: registeredAt,
        wallet2RegisteredAt: null
      })
    ]
  };
}

function planRegistration(
  event: ConsolidationEvent,
  sameDirection: Consolidation | null,
  reverseDirection: Consolidation | null
): ConsolidationRowPlan {
  const registeredAt = event.timestamp ?? null;
  if (sameDirection) {
    // wallet1 registered this direction again. The row and its block are
    // unchanged; only the registration time moves.
    if (registeredAt === null) {
      return { remove: [], save: [] };
    }
    const refreshed = copyRow(sameDirection);
    refreshed.wallet1_registered_at = registeredAt;
    return { remove: [], save: [refreshed] };
  }
  if (reverseDirection) {
    // Completes the pair, or repeats the second registration of an already
    // confirmed pair. Both keep the long-standing behaviour of stamping the
    // row with this event's block.
    return {
      remove: [reverseDirection],
      save: [
        newRow({
          block: event.block,
          wallet1: event.wallet2,
          wallet2: event.wallet1,
          confirmed: true,
          wallet1RegisteredAt: reverseDirection.wallet1_registered_at,
          wallet2RegisteredAt: registeredAt
        })
      ]
    };
  }
  return {
    remove: [],
    save: [
      newRow({
        block: event.block,
        wallet1: event.wallet1,
        wallet2: event.wallet2,
        confirmed: false,
        wallet1RegisteredAt: registeredAt,
        wallet2RegisteredAt: null
      })
    ]
  };
}

function planRevocation(
  event: ConsolidationEvent,
  sameDirection: Consolidation | null,
  reverseDirection: Consolidation | null
): ConsolidationRowPlan {
  if (sameDirection) {
    if (!sameDirection.confirmed) {
      return { remove: [sameDirection], save: [] };
    }
    // The revoking wallet was wallet1, so wallet2's direction remains.
    return {
      remove: [sameDirection],
      save: [
        newRow({
          block: event.block,
          wallet1: event.wallet2,
          wallet2: event.wallet1,
          confirmed: false,
          wallet1RegisteredAt: sameDirection.wallet2_registered_at,
          wallet2RegisteredAt: null
        })
      ]
    };
  }
  if (reverseDirection) {
    // The revoking wallet is the row's wallet2. If the row was confirmed its
    // direction is now gone; if not, it never existed. Either way only the
    // row's wallet1 direction remains.
    return {
      remove: [reverseDirection],
      save: [
        newRow({
          block: event.block,
          wallet1: event.wallet2,
          wallet2: event.wallet1,
          confirmed: false,
          wallet1RegisteredAt: reverseDirection.wallet1_registered_at,
          wallet2RegisteredAt: null
        })
      ]
    };
  }
  return { remove: [], save: [] };
}

function newRow({
  block,
  wallet1,
  wallet2,
  confirmed,
  wallet1RegisteredAt,
  wallet2RegisteredAt
}: {
  block: number;
  wallet1: string;
  wallet2: string;
  confirmed: boolean;
  wallet1RegisteredAt: number | null;
  wallet2RegisteredAt: number | null;
}): Consolidation {
  const row = new Consolidation();
  row.block = block;
  row.wallet1 = wallet1;
  row.wallet2 = wallet2;
  row.confirmed = confirmed;
  row.wallet1_registered_at = wallet1RegisteredAt;
  row.wallet2_registered_at = wallet2RegisteredAt;
  return row;
}

function copyRow(row: Consolidation): Consolidation {
  return Object.assign(new Consolidation(), row);
}
