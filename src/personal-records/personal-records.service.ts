import { createHash } from 'node:crypto';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import type { RecordAnchorService } from '@/signed-records/record-anchor';
import {
  IngestOutcome,
  KEYS_LABEL,
  RecordHeadKey,
  RecordHeadStore,
  RecordIndexer,
  RecordRegistry,
  SenderKeyring
} from '@/signed-records/record-index';
import { RecordKind } from '@/signed-records/record-kinds';
import {
  compareOrderKeys,
  RecordOrderKey
} from '@/signed-records/record-order';
import {
  decodeKeysDocument,
  ProviderKey
} from '@/signed-records/sealed-crypto';
import {
  RecordGrantSource,
  verifyRecordEvent,
  VerifiedRecord
} from '@/signed-records/record-verify';
import type { RecordLogWriter } from '@/signed-records/record-log/record-log.service';
import { ownersUnavailable } from './personal-records.ports';
import type { RecordOwnerDirectory } from './record-owner-directory';

/** At most this many records in one submit. */
export const PERSONAL_SUBMIT_MAX_EVENTS = 16;

/** The record log lane for personal records. */
export const PERSONAL_LOG_LANE = 'personal';

const READER_TYPE = 'reader';
// The head that holds each owner's newest applied settings record.
const OWNER_MARK_TYPE = '~owner';

export type PersonalSubmitOutcome =
  // Indexed: the tables changed (primary) or would have (shadow).
  | 'applied'
  // Valid, but a newer change for every key is already indexed.
  | 'stale'
  // A keys or reader record, kept in the log for readers.
  | 'logged'
  // Failed verification (reason: the verify reason).
  | 'rejected'
  // Verified, but not accepted (reason: why, code: today's rule code).
  | 'refused';

export interface PersonalSubmitResult {
  readonly id: string | null;
  readonly outcome: PersonalSubmitOutcome;
  readonly reason?: string;
  readonly code?: string;
  readonly detail?: string;
}

export interface PersonalRecordsDeps {
  readonly grants: RecordGrantSource;
  readonly owners: RecordOwnerDirectory;
  readonly anchors: Pick<RecordAnchorService, 'getAnchor'>;
  readonly heads: RecordHeadStore;
  // Primary applies and keeps; shadow applies in a transaction it rolls
  // back, so today's rules run and no table changes.
  readonly registry: RecordRegistry;
  readonly providers: () => readonly ProviderKey[];
  readonly log: Pick<RecordLogWriter, 'appendEvents'>;
  // The latest import's order key: a setting ordered at or before it lost
  // to the import (a rebuild applies only what comes after it).
  readonly importOrder: () => Promise<RecordOrderKey | null>;
  readonly now?: () => number;
  readonly maxClockSkewMs: number;
}

/** Thrown inside a record's transaction to roll it back with a result. */
class Refusal extends Error {
  constructor(readonly result: PersonalSubmitResult) {
    super(result.detail ?? result.reason ?? 'refused');
    Object.setPrototypeOf(this, Refusal.prototype);
  }
}

/** Thrown after a shadow check applied: rolls the check's writes back. */
class ShadowChecked extends Error {
  constructor(readonly result: PersonalSubmitResult) {
    super('shadow check');
    Object.setPrototypeOf(this, ShadowChecked.prototype);
  }
}

function refusal(
  record: VerifiedRecord,
  reason: string,
  detail: string,
  code?: string
): Refusal {
  return new Refusal({
    id: record.event.id,
    outcome: 'refused',
    reason,
    detail,
    ...(code ? { code } : {})
  });
}

function isKeysRecord(record: VerifiedRecord): boolean {
  return (
    record.parsed.kind === RecordKind.SEALED &&
    record.parsed.label === KEYS_LABEL
  );
}

/**
 * POST /signed-records for personal settings. Each record is verified live
 * (grant, anchor window, clock), must belong to the signed-in profile, and
 * is then applied (primary) or only checked (shadow), and appended to the
 * record log, in one transaction per record. A device's `keys` record
 * travels with every submit that carries sealed items: 6529.io keeps no
 * sender keys between requests.
 */
export class PersonalRecordsService {
  private readonly logger = Logger.get('PERSONAL_RECORDS');

  constructor(private readonly deps: PersonalRecordsDeps) {}

  async submit(
    events: readonly unknown[],
    mode: 'shadow' | 'primary',
    actorProfileId: string,
    ctx: RequestContext
  ): Promise<PersonalSubmitResult[]> {
    const anchor = await this.deps.anchors.getAnchor();
    const importOrder = await this.deps.importOrder();
    const now = (this.deps.now ?? Date.now)();
    const results = new Map<number, PersonalSubmitResult>();
    const accepted: { index: number; record: VerifiedRecord }[] = [];
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      let verified: Awaited<ReturnType<typeof verifyRecordEvent>>;
      try {
        verified = await verifyRecordEvent(event, {
          grants: this.deps.grants,
          bindings: this.deps.owners,
          live: {
            now,
            head: anchor.anchor,
            maxAnchorLag: anchor.maxAnchorLag,
            maxClockSkewMs: this.deps.maxClockSkewMs
          }
        });
      } catch {
        // A bad record answers as a verify result; a throw here is the
        // gateway failing to say whose the author's wallet was.
        throw ownersUnavailable();
      }
      if (!verified.ok) {
        results.set(index, {
          id: idOf(event),
          outcome: 'rejected',
          reason: verified.reason,
          detail: verified.detail
        });
        continue;
      }
      const record = verified.record;
      const owned = await this.checkOwner(record, actorProfileId);
      if (owned) {
        results.set(index, owned);
        continue;
      }
      accepted.push({ index, record });
    }
    // Keys first, so sealed items in the same submit open; then in merge
    // order, as a rebuild applies them.
    accepted.sort((a, b) => {
      const keys =
        Number(isKeysRecord(b.record)) - Number(isKeysRecord(a.record));
      return keys !== 0
        ? keys
        : compareOrderKeys(a.record.order, b.record.order);
    });
    const keyring = new SenderKeyring(this.deps.providers());
    const indexer = new RecordIndexer({
      registry: this.deps.registry,
      heads: this.deps.heads,
      keyring
    });
    for (const { index, record } of accepted) {
      results.set(
        index,
        await this.submitOne(record, indexer, importOrder, mode, ctx)
      );
    }
    const answered = events.map(
      (_, index): PersonalSubmitResult =>
        results.get(index) ?? {
          id: idOf(events[index]),
          outcome: 'refused',
          reason: 'not-processed'
        }
    );
    // One line per outcome, reason and kind, never a record's contents:
    // the switch's go/no-go reads these.
    const counts = new Map<string, number>();
    answered.forEach((result, index) => {
      const what = accepted.find((it) => it.index === index)?.record;
      const kind = what
        ? `${what.family}:${what.parsed.kind === RecordKind.RECORD ? what.parsed.type : what.parsed.kind === RecordKind.SEALED ? what.parsed.label : what.parsed.kind}`
        : 'unverified';
      const key = `${result.outcome} ${result.reason ?? '-'} ${result.code ?? '-'} ${kind}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    for (const [key, count] of Array.from(counts.entries())) {
      this.logger.info(`[PERSONAL RECORDS] mode=${mode} ${key} x${count}`);
    }
    return answered;
  }

  private async checkOwner(
    record: VerifiedRecord,
    actorProfileId: string
  ): Promise<PersonalSubmitResult | null> {
    const id = record.event.id;
    if (record.writer !== 'author' || !['ps', 'pv'].includes(record.family)) {
      return {
        id,
        outcome: 'refused',
        reason: 'not-personal',
        detail: 'Only your own ps and pv records are accepted here'
      };
    }
    const ownerProfileId = await this.deps.owners.profileIdOf(record.owner);
    if (ownerProfileId !== actorProfileId) {
      return {
        id,
        outcome: 'refused',
        reason: 'not-yours',
        detail: 'The record belongs to another profile than the signed-in one'
      };
    }
    return null;
  }

  private async submitOne(
    record: VerifiedRecord,
    indexer: RecordIndexer,
    importOrder: RecordOrderKey | null,
    mode: 'shadow' | 'primary',
    ctx: RequestContext
  ): Promise<PersonalSubmitResult> {
    try {
      return await this.deps.heads.inTransaction(
        { ...ctx, connection: undefined },
        (txCtx) => this.ingestOne(record, indexer, importOrder, mode, txCtx)
      );
    } catch (error) {
      if (error instanceof Refusal) {
        return error.result;
      }
      if (error instanceof ShadowChecked) {
        // The check's writes are rolled back; the record goes to the log.
        await this.deps.heads.inTransaction(
          { ...ctx, connection: undefined },
          (txCtx) =>
            this.deps.log.appendEvents(PERSONAL_LOG_LANE, [record.event], txCtx)
        );
        return error.result;
      }
      throw error;
    }
  }

  private async ingestOne(
    record: VerifiedRecord,
    indexer: RecordIndexer,
    importOrder: RecordOrderKey | null,
    mode: 'shadow' | 'primary',
    ctx: RequestContext
  ): Promise<PersonalSubmitResult> {
    const id = record.event.id;
    const parsed = record.parsed;
    if (parsed.kind === RecordKind.RECORD && record.family === 'pv') {
      if (parsed.type !== READER_TYPE) {
        throw refusal(record, 'not-accepted', 'pv carries reader records only');
      }
      return this.logOnce(record, READER_TYPE, parsed.key, ctx);
    }
    if (isKeysRecord(record)) {
      if (this.deps.providers().length === 0) {
        throw refusal(
          record,
          'provider-unavailable',
          'No provider key is configured, so sealed settings cannot be read'
        );
      }
      const outcome = await indexer.ingest(record, 'live', ctx);
      if (outcome.kind === 'refused') {
        throw refusal(record, outcome.reason, outcome.detail);
      }
      if (outcome.kind === 'keys' && outcome.conflicts > 0) {
        throw refusal(
          record,
          'keys-conflict',
          'A sender key for this device and generation is already known with other bytes'
        );
      }
      return this.logOnce(record, KEYS_LABEL, keysDocumentKey(record), ctx);
    }
    const isSettings =
      (parsed.kind === RecordKind.RECORD && record.family === 'ps') ||
      (parsed.kind === RecordKind.SEALED && record.family === 'pv');
    if (!isSettings) {
      throw refusal(
        record,
        'not-accepted',
        'Personal settings are ps RECORDs and pv SEALED records'
      );
    }
    if (importOrder && compareOrderKeys(record.order, importOrder) <= 0) {
      return { id, outcome: 'stale' };
    }
    // Settings depend on each other (a block removes a follow; wave-notify
    // needs the follow), and a rebuild applies them in signed order. So,
    // live, a record ordered before the owner's newest applied one is
    // refused: the client signs it again, after that mark.
    const markKey: RecordHeadKey = {
      owner: record.owner,
      family: 'pv',
      type: OWNER_MARK_TYPE,
      key: ''
    };
    const mark = await this.deps.heads.lock(markKey, ctx);
    if (mark && compareOrderKeys(record.order, mark) < 0) {
      throw refusal(
        record,
        'out-of-order',
        `A newer change of yours is already saved (anchor ${mark.anchor}, time ${mark.claimedTime}). Sign this one again.`,
        'OUT_OF_ORDER'
      );
    }
    const outcome = await indexer.ingest(record, 'live', ctx);
    const applied = this.appliedOrRefusal(record, outcome);
    if (applied.outcome === 'applied') {
      if (mode === 'shadow') {
        throw new ShadowChecked({ id, ...applied });
      }
      await this.deps.heads.put(markKey, record.order, ctx);
      await this.deps.log.appendEvents(PERSONAL_LOG_LANE, [record.event], ctx);
    }
    return { id, ...applied };
  }

  private appliedOrRefusal(
    record: VerifiedRecord,
    outcome: IngestOutcome
  ): { outcome: 'applied' | 'stale' } {
    switch (outcome.kind) {
      case 'applied':
        if (outcome.unknown > 0) {
          throw refusal(
            record,
            'unknown-type',
            'The record has items of types 6529.io does not know'
          );
        }
        return { outcome: outcome.changes > 0 ? 'applied' : 'stale' };
      case 'refused':
        throw refusal(record, outcome.reason, outcome.detail, outcome.code);
      case 'skipped': {
        const details: Record<typeof outcome.reason, string> = {
          'no-handler': 'The record has items of types 6529.io does not know',
          'own-class': 'Own-class items are not sent to 6529.io',
          'no-sender-key':
            "Send the device's keys record with its sealed settings",
          'not-indexed': 'Not a settings record',
          payload: 'Settings are inline, not payload references',
          del: 'DEL is not accepted here'
        };
        throw refusal(record, outcome.reason, details[outcome.reason]);
      }
      case 'keys':
        throw refusal(record, 'not-accepted', 'Unexpected keys record');
    }
  }

  /**
   * Keys and reader records change no table; they are logged once, when
   * newer than the last one logged for the same device or reader.
   */
  private async logOnce(
    record: VerifiedRecord,
    type: string,
    key: string,
    ctx: RequestContext
  ): Promise<PersonalSubmitResult> {
    const headKey: RecordHeadKey = {
      owner: record.owner,
      family: record.family,
      type: `~${type}`,
      key
    };
    const head = await this.deps.heads.lock(headKey, ctx);
    // Keys: any record for the same keys was enough. Readers: the newest wins.
    if (
      head &&
      (type === KEYS_LABEL || compareOrderKeys(record.order, head) <= 0)
    ) {
      return { id: record.event.id, outcome: 'stale' };
    }
    await this.deps.heads.put(headKey, record.order, ctx);
    await this.deps.log.appendEvents(PERSONAL_LOG_LANE, [record.event], ctx);
    return { id: record.event.id, outcome: 'logged' };
  }
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
    .sort()
    .join(',');
  return createHash('sha256')
    .update(`${record.event.device_key}|${wraps}`)
    .digest('hex');
}

function idOf(event: unknown): string | null {
  if (event && typeof event === 'object' && 'id' in event) {
    const id = (event as { id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}
