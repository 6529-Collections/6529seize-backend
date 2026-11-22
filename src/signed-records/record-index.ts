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
}

export type ApplyMode = 'live' | 'rebuild';

/**
 * What a lane registers for each of its types. `validate` throws for a body
 * the type does not accept; `apply` writes the index (and, live, today's side
 * effects). Rebuilds apply without side effects.
 */
export interface RecordTypeHandler {
  readonly family: 'ps' | 'pv';
  readonly type: string;
  readonly sealed: boolean;
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

export interface RecordHeadStore {
  get(key: RecordHeadKey, ctx: RequestContext): Promise<RecordOrderKey | null>;
  put(
    key: RecordHeadKey,
    order: RecordOrderKey,
    ctx: RequestContext
  ): Promise<void>;
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

/**
 * Sender keys 6529.io can read: the PROVIDER-class keys each device wraps to
 * a provider key in its `keys` record. Held in memory only; a rebuild reads
 * the `keys` records again.
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
  ) {
    return `${owner}|${deviceKey.toLowerCase()}|${cls}|${gen}`;
  }

  /** Unwraps every provider wrap of a verified `keys` record; returns the count. */
  addKeysRecord(record: VerifiedRecord): number {
    const parsed = record.parsed;
    if (parsed.kind !== RecordKind.SEALED || parsed.label !== KEYS_LABEL) {
      return 0;
    }
    const doc = decodeKeysDocument(parsed.bytes);
    if (doc.dev !== record.event.device_key) {
      throw new SealedFormatError('keys document names another device');
    }
    let unwrapped = 0;
    for (const wrap of doc.wraps) {
      const provider = this.providers.find(
        (candidate) => providerRecipient(candidate) === wrap.to
      );
      if (!provider || wrap.cls !== SealedClass.PROVIDER) {
        continue;
      }
      try {
        const key = unwrapSenderKey({
          wave: record.event.wave,
          wrap,
          provider
        });
        this.keys.set(
          SenderKeyring.id(record.owner, wrap.from, wrap.cls, wrap.gen),
          key
        );
        unwrapped++;
      } catch (error) {
        this.logger.warn(
          `Wrap in ${record.event.id} for ${wrap.to} does not open: ${String(error)}`
        );
      }
    }
    return unwrapped;
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
      // Items of types no handler is registered for (a newer client's).
      readonly unknown: number;
    }
  | { readonly kind: 'keys'; readonly unwrapped: number }
  | {
      readonly kind: 'skipped';
      readonly reason:
        | 'no-handler'
        | 'own-class'
        | 'no-sender-key'
        | 'not-indexed'
        | 'del';
    };

/**
 * Index records: keep only changes newer than the stored head for their
 * key, check them with the type's handler, apply them. Handles RECORD in
 * `ps` and PROVIDER-class SEALED items in `pv`; the rest is the lanes'.
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
        sealedClass: null
      };
      return this.applyChanges([change], false, mode, ctx);
    }
    if (parsed.kind === RecordKind.SEALED && record.family === 'pv') {
      return this.ingestSealed(record, parsed.label, parsed.bytes, mode, ctx);
    }
    return { kind: 'skipped', reason: 'not-indexed' };
  }

  private async ingestSealed(
    record: VerifiedRecord,
    label: string,
    bytes: Buffer,
    mode: ApplyMode,
    ctx: RequestContext
  ): Promise<IngestOutcome> {
    if (label === KEYS_LABEL) {
      return {
        kind: 'keys',
        unwrapped: this.deps.keyring.addKeysRecord(record)
      };
    }
    if (bytes[0] !== SealedFormat.ITEMS) {
      return { kind: 'skipped', reason: 'not-indexed' };
    }
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
    const changes = opened.items.map(
      (item): RecordChange => ({
        owner: record.owner,
        family: 'pv',
        type: item.t,
        key: item.k,
        body: item.b,
        order: record.order,
        eventId: record.event.id,
        sealedClass: header.cls
      })
    );
    return this.applyChanges(changes, true, mode, ctx);
  }

  /** Imported state, each change at its import order key. */
  async ingestImported(
    changes: readonly RecordChange[],
    sealed: boolean,
    mode: ApplyMode,
    ctx: RequestContext
  ): Promise<IngestOutcome> {
    return this.applyChanges(changes, sealed, mode, ctx);
  }

  private async applyChanges(
    changes: readonly RecordChange[],
    sealed: boolean,
    mode: ApplyMode,
    ctx: RequestContext
  ): Promise<IngestOutcome> {
    // Later items for the same key in one record win: keep the last of each.
    const latest = new Map<string, RecordChange>();
    for (const change of changes) {
      latest.set(`${change.type}|${change.key}`, change);
    }
    const handled: { change: RecordChange; handler: RecordTypeHandler }[] = [];
    let unknown = 0;
    for (const change of Array.from(latest.values())) {
      const handler = this.deps.registry.find(
        change.family as 'ps' | 'pv',
        change.type,
        sealed
      );
      if (handler) {
        handled.push({ change, handler });
      } else {
        unknown++;
      }
    }
    if (handled.length === 0) {
      return { kind: 'skipped', reason: 'no-handler' };
    }
    for (const { change, handler } of handled) {
      handler.validate(change);
    }
    let applied = 0;
    let stale = 0;
    for (const { change, handler } of handled) {
      const headKey: RecordHeadKey = {
        owner: change.owner,
        family: change.family,
        type: change.type,
        key: change.key
      };
      const head = await this.deps.heads.get(headKey, ctx);
      if (head && compareOrderKeys(change.order, head) <= 0) {
        stale++;
        continue;
      }
      await handler.apply(change, mode, ctx);
      await this.deps.heads.put(headKey, change.order, ctx);
      applied++;
    }
    return { kind: 'applied', changes: applied, stale, unknown };
  }
}
