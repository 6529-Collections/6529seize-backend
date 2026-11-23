import { ethers } from 'ethers';
import type { SignedRecordEvent } from './record-event';

/**
 * The merge order of records: the newest change per (owner, type, key)
 * wins by (anchor, claimed time, event id), as P33 3.5 and the relays order
 * them.
 */
export interface RecordOrderKey {
  readonly anchor: number;
  readonly claimedTime: number;
  readonly eventId: string;
}

export function orderKeyOf(event: SignedRecordEvent): RecordOrderKey {
  return {
    anchor: event.anchor,
    claimedTime: event.claimed_time,
    eventId: event.id.toLowerCase()
  };
}

/** Imported state sits at the import's height and time, below any record there. */
export function importOrderKey(anchor: number, time: number): RecordOrderKey {
  return { anchor, claimedTime: time, eventId: ethers.ZeroHash };
}

/** Sorts strings by code unit: the same everywhere, unlike a locale. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

function compareNumbers(a: number, b: number): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

export function compareOrderKeys(a: RecordOrderKey, b: RecordOrderKey): number {
  const byAnchor = compareNumbers(a.anchor, b.anchor);
  if (byAnchor !== 0) {
    return byAnchor;
  }
  const byTime = compareNumbers(a.claimedTime, b.claimedTime);
  if (byTime !== 0) {
    return byTime;
  }
  const left = a.eventId.toLowerCase();
  const right = b.eventId.toLowerCase();
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
