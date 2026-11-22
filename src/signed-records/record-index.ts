import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { RecordFamily } from './record-families';
import { RecordKind } from './record-kinds';
import { compareOrderKeys, RecordOrderKey } from './record-order';
import type { VerifiedRecord } from './record-verify';
import {
  decodeKeysDocument,
  openSealedItems,
  ProviderKey,
  providerRecipient,
  readSealedItemsHeader,
  SealedClass,
  SealedFormat,
  SealedFormatError,
  SealedItem,
  unwrapSenderKey
} from './sealed-crypto';

export const KEYS_LABEL = 'keys';

/** One change to one key of a person's state, from a record or the import. */
export interface RecordChange {
  readonly owner: string;
  readonly family: RecordFamily;
  readonly type: string;
  // '' for a RECORD whose refs are [type].
  readonly key: string;
  // null unsets the key.
  readonly body: Record<string, unknown> | null;
  readonly order: RecordOrderKey;
  // null for imported state.
  readonly eventId: string | null;
  // null for a RECORD.
  readonly sealedClass: number | null;
  // 'orderer' when the orderer role wrote the record into the owner's stream.
  readonly writer: 'author' | 'orderer';
}

export type ApplyMode = 'live' | 'rebuild';

/**
 * Thrown by a handler's `apply` when today's rules refuse a live change (a
 * follow of a profile you block, a missing target). The record's
 * transaction rolls back and the outcome is `refused` with reason `rule`.
 * Rebuilds never check these rules: the records were accepted when sent.
 */
export class RecordRuleError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    // Keeps instanceof working when compiled to ES5.
    Object.setPrototypeOf(this, RecordRuleError.prototype);
  }
}

/**
 * What a lane registers for each of its types. `validate` throws for a body
 * the type does not accept (the record is then refused, nothing applied);
 * `apply` writes the index and, live, today's side effects. A
 * RecordRuleError from `apply` refuses the record; any other error is an
 * infrastructure error and propagates. Rebuilds apply without side effects.
 */
export interface RecordTypeHandler {
  readonly family: 'ps' | 'pv';
  readonly type: string;
  readonly sealed: boolean;
  /**
   * Whether the type takes items the orderer role wrote into a person's
   * stream (publish's `cms`). Off by default: an orderer item is never
   * applied as the person's own setting.
   */
  readonly acceptsOrderer?: boolean;
  validate(change: RecordChange): void;
  apply(
    change: RecordChange,
    mode: ApplyMode,
    ctx: RequestContext
  ): Promise<void>;
}

export interface RecordHeadKey {
  readonly owner: string;
  readonly family: RecordFamily;
  readonly type: string;
  readonly key: string;
}

/**
 * The newest order key indexed per key. `lock` reads it and holds a lock on
 * it until the transaction in ctx.connection ends, so two submits for one
 * key are applied one after the other; it requires ctx.connection.
 */
export interface RecordHeadStore {
  lock(key: RecordHeadKey, ctx: RequestContext): Promise<RecordOrderKey | null>;
  put(
    key: RecordHeadKey,
    order: RecordOrderKey,
    ctx: RequestContext
  ): Promise<void>;
  /**
   * Runs fn in a transaction, or in the caller's when ctx has one. Either
   * way, when fn throws, none of its writes stay: in the caller's
   * transaction they are rolled back to a savepoint taken before fn.
   */
  inTransaction<T>(
    ctx: RequestContext,
    fn: (ctx: RequestContext) => Promise<T>
  ): Promise<T>;
}

export class RecordRegistry {
  private readonly handlers = new Map<string, RecordTypeHandler>();

  private static id(family: string, type: string, sealed: boolean): string {
    return `${family}|${sealed ? 'sealed' : 'record'}|${type}`;
  }

  register(handler: RecordTypeHandler): void {
    const id = RecordRegistry.id(handler.family, handler.type, handler.sealed);
    if (this.handlers.has(id)) {
      throw new Error(`Record type ${id} is already registered`);
    }
    this.handlers.set(id, handler);
  }

  find(
    family: 'ps' | 'pv',
    type: string,
    sealed: boolean
  ): RecordTypeHandler | null {
    return this.handlers.get(RecordRegistry.id(family, type, sealed)) ?? null;
  }
}

export interface KeyringResult {
  readonly unwrapped: number;
  // Wraps naming a (device, class, generation) that already has another key.
  readonly conflicts: number;
}

/**
 * Sender keys 6529.io can read: the PROVIDER-class keys each device wraps to
 * a provider key in its `keys` record. Held in memory only; a rebuild reads
 * the `keys` records again. A second, different key for the same device,
 * class and generation is refused: the first one stays.
 */
export class SenderKeyring {
  private readonly logger = Logger.get(SenderKeyring.name);
  private readonly keys = new Map<string, Buffer>();

  constructor(private readonly providers: readonly ProviderKey[]) {}

  private static id(
    owner: string,
    deviceKey: string,
    cls: number,
    gen: number
  ): string {
    return `${owner}|${deviceKey.toLowerCase()}|${cls}|${gen}`;
  }

  /** Unwraps every provider wrap of a verified `keys` record. Throws SealedFormatError. */
  addKeysRecord(record: VerifiedRecord): KeyringResult {
    const parsed = record.parsed;
    if (
      parsed.kind !== RecordKind.SEALED ||
      parsed.label !== KEYS_LABEL ||
      parsed.bytes === null
    ) {
      throw new SealedFormatError('not a keys record');
    }
    const doc = decodeKeysDocument(parsed.bytes);
    if (doc.dev !== record.event.device_key) {
      throw new SealedFormatError('keys document names another device');
    }
    let unwrapped = 0;
    let conflicts = 0;
    for (const wrap of doc.wraps) {
      const provider = this.providers.find(
        (candidate) => providerRecipient(candidate) === wrap.to
      );
      // A device publishes wraps of its own keys; others re-wrap later (Own).
      if (
        !provider ||
        wrap.cls !== SealedClass.PROVIDER ||
        wrap.from !== doc.dev
      ) {
        continue;
      }
      let key: Buffer;
      try {
        key = unwrapSenderKey({ wave: record.event.wave, wrap, provider });
      } catch (error) {
        this.logger.warn(
          `Wrap in ${record.event.id} for ${wrap.to} does not open: ${String(error)}`
        );
        continue;
      }
      const id = SenderKeyring.id(record.owner, wrap.from, wrap.cls, wrap.gen);
      const known = this.keys.get(id);
      if (known && !known.equals(key)) {
        conflicts++;
        continue;
      }
      this.keys.set(id, key);
      unwrapped++;
    }
    return { unwrapped, conflicts };
  }

  find(
    owner: string,
    deviceKey: string,
    cls: number,
    gen: number
  ): Buffer | null {
    return this.keys.get(SenderKeyring.id(owner, deviceKey, cls, gen)) ?? null;
  }
}

export type IngestOutcome =
  | {
      readonly kind: 'applied';
      readonly changes: number;
      readonly stale: number;
      // Items no handler takes: types none is registered for (a newer
      // client's), or the orderer's items for a type that does not take them.
      readonly unknown: number;
    }
  | {
      readonly kind: 'keys';
      readonly unwrapped: number;
      readonly conflicts: number;
    }
  | {
      readonly kind: 'skipped';
      readonly reason:
        | 'no-handler'
        | 'own-class'
        | 'no-sender-key'
        | 'not-indexed'
        | 'payload'
        | 'del';
    }
  // The record's content is bad: nothing of it was applied.
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'sealed-format'
        | 'keys-format'
        | 'invalid-change'
        | 'rule';
      readonly detail: string;
      // The rule's code, for reason `rule`.
      readonly code?: string;
    };

type Refused = Extract<IngestOutcome, { kind: 'refused' }>;

const refused = (reason: Refused['reason'], error: unknown): Refused => ({
  kind: 'refused',
  reason,
  detail: error instanceof Error ? error.message : String(error)
});

/**
 * Index records: keep only changes newer than the stored head for their
 * key, check them with the type's handler, apply them, in one transaction
 * per record with the heads locked. Handles RECORD in `ps` and
 * PROVIDER-class SEALED items in `pv`; the rest is the lanes'. Bad record
 * content gives `refused`, so one bad record never stops a rebuild; only
 * infrastructure errors (the database, a handler's apply) throw. When ctx
 * already holds a transaction, a `rule` refusal undoes the record's writes
 * (the heads store's savepoint), so the caller may still commit.
 */
export class RecordIndexer {
  constructor(
    private readonly deps: {
      readonly registry: RecordRegistry;
      readonly heads: RecordHeadStore;
      readonly keyring: SenderKeyring;
    }
  ) {}

  async ingest(
    record: VerifiedRecord,
    mode: ApplyMode,
    ctx: RequestContext
  ): Promise<IngestOutcome> {
    const parsed = record.parsed;
    if (parsed.kind === RecordKind.DEL) {
      return { kind: 'skipped', reason: 'del' };
    }
    if (parsed.kind === RecordKind.RECORD && record.family === 'ps') {
      const change: RecordChange = {
        owner: record.owner,
        family: 'ps',
        type: parsed.type,
        key: parsed.key,
        body: parsed.body,
        order: record.order,
        eventId: record.event.id,
        sealedClass: null,
        writer: record.writer
      };
      return this.applyChanges([change], false, mode, ctx);
    }
    if (parsed.kind === RecordKind.SEALED && record.family === 'pv') {
      if (parsed.bytes === null) {
        return { kind: 'skipped', reason: 'payload' };
      }
      return this.ingestSealed(record, parsed.label, parsed.bytes, mode, ctx);
    }
    return { kind: 'skipped', reason: 'not-indexed' };
  }

  private ingestKeys(record: VerifiedRecord): IngestOutcome {
    try {
      return { kind: 'keys', ...this.deps.keyring.addKeysRecord(record) };
    } catch (error) {
      if (error instanceof SealedFormatError) {
        return refused('keys-format', error);
      }
      throw error;
    }
  }

  private openItems(
    record: VerifiedRecord,
    bytes: Buffer
  ): { items: SealedItem[]; cls: number } | IngestOutcome {
    try {
      const header = readSealedItemsHeader(bytes);
      if (header.cls !== SealedClass.PROVIDER) {
        return { kind: 'skipped', reason: 'own-class' };
      }
      if (header.deviceKey !== record.event.device_key) {
        throw new SealedFormatError('sealed items name another device');
      }
      const senderKey = this.deps.keyring.find(
        record.owner,
        header.deviceKey,
        header.cls,
        header.gen
      );
      if (!senderKey) {
        return { kind: 'skipped', reason: 'no-sender-key' };
      }
      const opened = openSealedItems({
        wave: record.event.wave,
        bytes,
        senderKey
      });
      return { items: opened.items, cls: header.cls };
    } catch (error) {
      if (error instanceof SealedFormatError) {
        return refused('sealed-format', error);
      }
      throw error;
    }
  }

  private async ingestSealed(
    record: VerifiedRecord,
    label: string,
    bytes: Buffer,
    mode: ApplyMode,
    ctx: RequestContext
  ): Promise<IngestOutcome> {
    if (label === KEYS_LABEL) {
      return this.ingestKeys(record);
    }
    if (bytes[0] !== SealedFormat.ITEMS) {
      return { kind: 'skipped', reason: 'not-indexed' };
    }
    const opened = this.openItems(record, bytes);
    if ('kind' in opened) {
      return opened;
    }
    const changes = opened.items.map(
      (item): RecordChange => ({
        owner: record.owner,
        family: 'pv',
        type: item.t,
        key: item.k,
        body: item.b,
        order: record.order,
        eventId: record.event.id,
        sealedClass: opened.cls,
        writer: record.writer
      })
    );
    return this.applyChanges(changes, true, mode, ctx);
  }

  /**
   * Imported state, each change at its import order key. With `heads:
   * false` no head is written: state that live never puts through the
   * indexer (an import at a switch, a derived effect) leaves no head live
   * either, so a rebuild keeps none.
   */
  async ingestImported(
    changes: readonly RecordChange[],
    sealed: boolean,
    mode: ApplyMode,
    ctx: RequestContext,
    opts: { readonly heads?: boolean } = {}
  ): Promise<IngestOutcome> {
    return this.applyChanges(changes, sealed, mode, ctx, opts.heads !== false);
  }

  private async applyChanges(
    changes: readonly RecordChange[],
    sealed: boolean,
    mode: ApplyMode,
    ctx: RequestContext,
    writeHeads = true
  ): Promise<IngestOutcome> {
    // Later items for the same key in one record win: keep the last of
    // each, at its own position in the record.
    const latest = new Map<string, RecordChange>();
    for (const change of changes) {
      const id = `${change.type}|${change.key}`;
      latest.delete(id);
      latest.set(id, change);
    }
    const handled: { change: RecordChange; handler: RecordTypeHandler }[] = [];
    let unknown = 0;
    for (const change of Array.from(latest.values())) {
      const handler = this.deps.registry.find(
        change.family as 'ps' | 'pv',
        change.type,
        sealed
      );
      if (handler && (change.writer === 'author' || handler.acceptsOrderer)) {
        handled.push({ change, handler });
      } else {
        unknown++;
      }
    }
    if (handled.length === 0) {
      return { kind: 'skipped', reason: 'no-handler' };
    }
    try {
      for (const { change, handler } of handled) {
        handler.validate(change);
      }
    } catch (error) {
      return refused('invalid-change', error);
    }
    try {
      return await this.applyLocked(handled, unknown, mode, ctx, writeHeads);
    } catch (error) {
      if (error instanceof RecordRuleError) {
        return { ...refused('rule', error), code: error.code };
      }
      throw error;
    }
  }

  private async applyLocked(
    handled: readonly { change: RecordChange; handler: RecordTypeHandler }[],
    unknown: number,
    mode: ApplyMode,
    ctx: RequestContext,
    writeHeads: boolean
  ): Promise<IngestOutcome> {
    const headKeyOf = (change: RecordChange): RecordHeadKey => ({
      owner: change.owner,
      family: change.family,
      type: change.type,
      key: change.key
    });
    return this.deps.heads.inTransaction(ctx, async (txCtx) => {
      // Lock every head first, in one order, so two records sharing keys
      // cannot deadlock; then apply in the record's own item order (a
      // rename's new name before the old name's unset, as the client wrote
      // them), the same order a rebuild applies.
      const byLockOrder = [...handled].sort((a, b) =>
        headId(a.change) < headId(b.change)
          ? -1
          : Number(headId(a.change) > headId(b.change))
      );
      const isNewer = new Map<RecordChange, boolean>();
      for (const { change } of byLockOrder) {
        const head = await this.deps.heads.lock(headKeyOf(change), txCtx);
        isNewer.set(change, !head || compareOrderKeys(change.order, head) > 0);
      }
      let applied = 0;
      let stale = 0;
      for (const { change, handler } of handled) {
        if (!isNewer.get(change)) {
          stale++;
          continue;
        }
        await handler.apply(change, mode, txCtx);
        if (writeHeads) {
          await this.deps.heads.put(headKeyOf(change), change.order, txCtx);
        }
        applied++;
      }
      return { kind: 'applied' as const, changes: applied, stale, unknown };
    });
  }
}

function headId(change: RecordChange): string {
  return `${change.owner}|${change.family}|${change.type}|${change.key}`;
}
