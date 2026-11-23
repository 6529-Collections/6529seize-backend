import { createHash } from 'node:crypto';
import type { RequestContext } from '@/request.context';
import {
  KEYS_LABEL,
  RecordHeadKey,
  RecordHeadStore
} from '@/signed-records/record-index';
import { RecordKind } from '@/signed-records/record-kinds';
import {
  byCodeUnit,
  compareOrderKeys,
  RecordOrderKey
} from '@/signed-records/record-order';
import type { VerifiedRecord } from '@/signed-records/record-verify';
import { decodeKeysDocument } from '@/signed-records/sealed-crypto';

/**
 * The heads the personal records service keeps beside the indexer's
 * per-key ones, written live and again by a rebuild: each owner's newest
 * applied settings record, and the keys and reader records already logged.
 */

/** The one RECORD type in pv: a reader record. */
export const READER_TYPE = 'reader';

export function isKeysRecord(record: VerifiedRecord): boolean {
  return (
    record.parsed.kind === RecordKind.SEALED &&
    record.parsed.label === KEYS_LABEL
  );
}

/**
 * The head that holds an owner's newest applied settings record. Settings
 * depend on each other and a rebuild applies them in signed order, so live
 * refuses a record ordered before it (OUT_OF_ORDER).
 */
export function ownerMarkKey(owner: string): RecordHeadKey {
  return { owner, family: 'pv', type: '~owner', key: '' };
}

/**
 * What a keys record holds, as a head key: its device and each wrap's
 * class, generation and recipient. A device that signs a new keys record
 * for the same keys (new HPKE wraps, a new event) is logged once; a new
 * generation or a new provider key is logged again.
 */
function keysDocumentKey(record: VerifiedRecord): string {
  const parsed = record.parsed;
  const doc =
    parsed.kind === RecordKind.SEALED && parsed.bytes
      ? decodeKeysDocument(parsed.bytes)
      : null;
  const wraps = (doc?.wraps ?? [])
    .map((wrap) => `${wrap.cls}:${wrap.gen}:${wrap.from}:${wrap.to}`)
    .sort(byCodeUnit)
    .join(',');
  return createHash('sha256')
    .update(`${record.event.device_key}|${wraps}`)
    .digest('hex');
}

/** The logged-once head of a keys or reader record; null for any other. */
function logHeadKey(record: VerifiedRecord): RecordHeadKey | null {
  const parsed = record.parsed;
  if (isKeysRecord(record)) {
    return {
      owner: record.owner,
      family: record.family,
      type: `~${KEYS_LABEL}`,
      key: keysDocumentKey(record)
    };
  }
  if (
    parsed.kind === RecordKind.RECORD &&
    record.family === 'pv' &&
    parsed.type === READER_TYPE
  ) {
    return {
      owner: record.owner,
      family: record.family,
      type: `~${READER_TYPE}`,
      key: parsed.key
    };
  }
  return null;
}

/**
 * Keys and reader records change no table; each is logged once, when newer
 * than the last one logged for the same keys or reader. In ctx's
 * transaction, takes the head that says so: true when this record is to be
 * logged (the head now holds it), false when one already logged covers it
 * (keys: any record for the same keys; readers: the newest wins).
 */
export async function takeLogHead(
  heads: RecordHeadStore,
  record: VerifiedRecord,
  ctx: RequestContext
): Promise<boolean> {
  const key = logHeadKey(record);
  if (!key) {
    throw new Error('Only keys and reader records are logged once');
  }
  const head = await heads.lock(key, ctx);
  if (
    head &&
    (isKeysRecord(record) || compareOrderKeys(record.order, head) <= 0)
  ) {
    return false;
  }
  await heads.put(key, record.order, ctx);
  return true;
}

/**
 * A rebuild's copy of these heads, as live left them: the logged-once
 * head of every keys and reader record in the log, in log order, and each
 * owner's mark at their newest settings record the rebuild applied.
 */
export async function restoreServiceHeads(
  heads: RecordHeadStore,
  records: readonly VerifiedRecord[],
  newestApplied: ReadonlyMap<string, RecordOrderKey>,
  ctx: RequestContext
): Promise<void> {
  for (const record of records) {
    if (logHeadKey(record)) {
      await heads.inTransaction(ctx, (txCtx) =>
        takeLogHead(heads, record, txCtx)
      );
    }
  }
  for (const [owner, order] of Array.from(newestApplied.entries())) {
    await heads.inTransaction(ctx, async (txCtx) => {
      await heads.lock(ownerMarkKey(owner), txCtx);
      await heads.put(ownerMarkKey(owner), order, txCtx);
    });
  }
}
