import { RequestContext } from '@/request.context';
import { signRecordEvent } from './record-event';
import {
  RecordChange,
  RecordHeadKey,
  RecordIndexer,
  RecordRegistry,
  RecordRuleError,
  RecordTypeHandler,
  SenderKeyring
} from './record-index';
import { RecordKind } from './record-kinds';
import { importOrderKey, RecordOrderKey } from './record-order';
import {
  bindingSource,
  grantSource,
  hexBytes,
  MemoryHeadStore,
  VECTOR_GRANT,
  vectorDeviceKey,
  VECTORS
} from './record-test-fixtures';
import { VerifiedRecord, verifyRecordEvent } from './record-verify';
import {
  encodeKeysDocument,
  SealedClass,
  SealedItem,
  sealItems,
  wrapSenderKey
} from './sealed-crypto';

const inputs = VECTORS.inputs;
const PRINCIPAL = inputs.principal;
const PV_WAVE = `pv/${PRINCIPAL}`;
const PS_WAVE = `ps/${PRINCIPAL}`;
const provider = {
  id: inputs.providerKeyId,
  privateKey: hexBytes(inputs.providerPrivateKey),
  publicKey: hexBytes(inputs.providerPublicKey)
};
const ctx = {};

class RecordingHandler implements RecordTypeHandler {
  readonly applied: { change: RecordChange; mode: string }[] = [];
  // What apply throws for a key, if anything.
  readonly failures = new Map<string, Error>();
  constructor(
    readonly family: 'ps' | 'pv',
    readonly type: string,
    readonly sealed: boolean
  ) {}
  validate(change: RecordChange): void {
    if (change.body && 'bad' in change.body) {
      throw new Error('bad body');
    }
  }
  async apply(change: RecordChange, mode: string): Promise<void> {
    const failure = this.failures.get(change.key);
    if (failure) {
      throw failure;
    }
    this.applied.push({ change, mode });
  }
}

/**
 * Logs locks and puts, and puts the heads back when the transaction's work
 * throws, as the database rolls back.
 */
class TransactionalHeadStore extends MemoryHeadStore {
  readonly log: string[] = [];

  async lock(key: RecordHeadKey): Promise<RecordOrderKey | null> {
    this.log.push(`lock ${key.key}`);
    return super.lock(key);
  }

  async put(key: RecordHeadKey, order: RecordOrderKey): Promise<void> {
    this.log.push(`put ${key.key}`);
    return super.put(key, order);
  }

  async inTransaction<T>(
    ctx: RequestContext,
    fn: (ctx: RequestContext) => Promise<T>
  ): Promise<T> {
    const before = new Map(this.heads);
    try {
      return await super.inTransaction(ctx, fn);
    } catch (error) {
      this.heads.clear();
      before.forEach((order, id) => this.heads.set(id, order));
      throw error;
    }
  }
}

async function verified(event: unknown): Promise<VerifiedRecord> {
  const result = await verifyRecordEvent(event, {
    grants: grantSource([VECTOR_GRANT]),
    bindings: bindingSource([
      { wallet: inputs.author, principal: PRINCIPAL, from: 1 }
    ])
  });
  if (!result.ok) {
    throw new Error(`${result.reason}: ${result.detail}`);
  }
  return result.record;
}

let seq = 1_800_000_000_000;
function record(
  kind: RecordKind,
  wave: string,
  refs: string[],
  body: object | null,
  anchor: number
) {
  seq += 1;
  return signRecordEvent(
    {
      kind,
      wave,
      refs,
      body,
      author: inputs.author,
      deviceKey: inputs.deviceKey,
      authRef: inputs.authRef,
      seq,
      anchor,
      claimedTime: seq
    },
    vectorDeviceKey()
  );
}

function setup<H extends MemoryHeadStore = MemoryHeadStore>(
  heads: H = new MemoryHeadStore() as H
) {
  const registry = new RecordRegistry();
  const follow = new RecordingHandler('ps', 'follow', false);
  const mute = new RecordingHandler('pv', 'mute', true);
  registry.register(follow);
  registry.register(mute);
  const keyring = new SenderKeyring([provider]);
  const indexer = new RecordIndexer({ registry, heads, keyring });
  return { registry, follow, mute, heads, keyring, indexer };
}

/**
 * A provider-class settings record holding `items`, after indexing the
 * device's keys record (anchor 1000) so the keyring can open it. The
 * settings record is at anchor 1001.
 */
async function sealedSettings(
  keyring: SenderKeyring,
  items: SealedItem[]
): Promise<VerifiedRecord> {
  const senderKey = hexBytes(inputs.senderKey);
  const wrap = wrapSenderKey({
    wave: PV_WAVE,
    cls: SealedClass.PROVIDER,
    gen: 3,
    from: inputs.deviceKey,
    to: `svc:${provider.id}`,
    recipientPublicKey: provider.publicKey,
    senderKey
  });
  const keys = encodeKeysDocument({
    v: 1,
    dev: inputs.deviceKey,
    box: null,
    wraps: [wrap]
  });
  keyring.addKeysRecord(
    await verified(
      record(
        RecordKind.SEALED,
        PV_WAVE,
        ['keys'],
        { c: keys.toString('base64url'), v: 1 },
        1000
      )
    )
  );
  const c = sealItems({
    wave: PV_WAVE,
    cls: SealedClass.PROVIDER,
    gen: 3,
    deviceKey: inputs.deviceKey,
    senderKey,
    items
  });
  return verified(
    record(
      RecordKind.SEALED,
      PV_WAVE,
      ['settings'],
      { c: c.toString('base64url'), v: 1 },
      1001
    )
  );
}

describe('RecordIndexer', () => {
  it('applies the newest public change per key and skips older ones', async () => {
    const { indexer, follow } = setup();
    const set = await verified(VECTORS.followRecord);
    const unset = await verified(VECTORS.followUnset);
    expect(await indexer.ingest(unset, 'rebuild', ctx)).toEqual({
      kind: 'applied',
      changes: 1,
      stale: 0,
      unknown: 0
    });
    expect(await indexer.ingest(set, 'rebuild', ctx)).toEqual({
      kind: 'applied',
      changes: 0,
      stale: 1,
      unknown: 0
    });
    expect(follow.applied).toHaveLength(1);
    expect(follow.applied[0].change).toMatchObject({
      owner: PRINCIPAL,
      family: 'ps',
      type: 'follow',
      key: `identity:${inputs.target}`,
      body: null,
      eventId: VECTORS.followUnset.id,
      sealedClass: null
    });
  });

  it('opens provider-class items once the keys record is indexed', async () => {
    const { indexer, mute } = setup();
    const sealed = await verified(VECTORS.sealedSettings.event);
    expect(await indexer.ingest(sealed, 'live', ctx)).toEqual({
      kind: 'skipped',
      reason: 'no-sender-key'
    });
    expect(
      await indexer.ingest(await verified(VECTORS.keys.event), 'live', ctx)
    ).toEqual({ kind: 'keys', unwrapped: 1, conflicts: 0 });
    expect(await indexer.ingest(sealed, 'live', ctx)).toMatchObject({
      kind: 'applied',
      changes: 1
    });
    expect(mute.applied[0]).toMatchObject({
      mode: 'live',
      change: {
        family: 'pv',
        type: 'mute',
        key: inputs.target,
        body: {},
        sealedClass: SealedClass.PROVIDER
      }
    });
  });

  it("never applies the orderer's items as the person's own, unless the type takes them", async () => {
    const { indexer, mute, registry } = setup();
    await indexer.ingest(await verified(VECTORS.keys.event), 'live', ctx);
    const byOrderer: VerifiedRecord = {
      ...(await verified(VECTORS.sealedSettings.event)),
      writer: 'orderer'
    };
    expect(await indexer.ingest(byOrderer, 'live', ctx)).toEqual({
      kind: 'skipped',
      reason: 'no-handler'
    });
    expect(mute.applied).toHaveLength(0);
    // A type that opts in (publish's cms) takes them, marked as the orderer's.
    const cms = Object.assign(new RecordingHandler('pv', 'cms', true), {
      acceptsOrderer: true
    });
    registry.register(cms);
    const c = sealItems({
      wave: PV_WAVE,
      cls: SealedClass.PROVIDER,
      gen: 1,
      deviceKey: inputs.deviceKey,
      senderKey: hexBytes(inputs.senderKey),
      items: [
        { t: 'cms', k: 'page', b: { v: 1 } },
        { t: 'mute', k: inputs.target, b: {} }
      ],
      fixedNonceForTests: Buffer.alloc(12, 7)
    });
    const mixed: VerifiedRecord = {
      ...(await verified(
        record(
          RecordKind.SEALED,
          PV_WAVE,
          ['settings'],
          { c: c.toString('base64url'), v: 1 },
          1000
        )
      )),
      writer: 'orderer'
    };
    expect(await indexer.ingest(mixed, 'live', ctx)).toEqual({
      kind: 'applied',
      changes: 1,
      stale: 0,
      unknown: 1
    });
    expect(cms.applied[0].change).toMatchObject({
      type: 'cms',
      writer: 'orderer'
    });
    expect(mute.applied).toHaveLength(0);
  });

  it('skips own-class items, which 6529.io cannot read', async () => {
    const { indexer } = setup();
    const c = sealItems({
      wave: PV_WAVE,
      cls: SealedClass.OWN,
      gen: 1,
      deviceKey: inputs.deviceKey,
      senderKey: hexBytes(inputs.senderKey),
      items: [{ t: 'bookmark', k: 'd1', b: {} }]
    });
    const event = record(
      RecordKind.SEALED,
      PV_WAVE,
      ['settings'],
      { c: c.toString('base64url'), v: 1 },
      1000
    );
    expect(await indexer.ingest(await verified(event), 'live', ctx)).toEqual({
      kind: 'skipped',
      reason: 'own-class'
    });
  });

  it('keeps the last item per key in a record and counts unknown types', async () => {
    const { indexer, keyring, mute } = setup();
    const settings = await sealedSettings(keyring, [
      { t: 'mute', k: 'p9', b: {} },
      { t: 'newer-type', k: 'x', b: {} },
      { t: 'mute', k: 'p9', b: null }
    ]);
    expect(await indexer.ingest(settings, 'live', ctx)).toEqual({
      kind: 'applied',
      changes: 1,
      stale: 0,
      unknown: 1
    });
    expect(mute.applied[0].change.body).toBeNull();
  });

  it('lets a newer record replace imported state, and not an older one', async () => {
    const { indexer, follow } = setup();
    const key = `identity:${inputs.target}`;
    const imported: RecordChange = {
      owner: PRINCIPAL,
      family: 'ps',
      type: 'follow',
      key,
      body: { actions: ['DROP_CREATED', 'DROP_REPLIED'] },
      order: importOrderKey(1000, VECTORS.followRecord.claimed_time + 1),
      eventId: null,
      sealedClass: null,
      writer: 'author'
    };
    await indexer.ingestImported([imported], false, 'rebuild', ctx);
    // The set record is older than the import: stale.
    expect(
      await indexer.ingest(await verified(VECTORS.followRecord), 'rebuild', ctx)
    ).toMatchObject({ stale: 1 });
    // The unset record is newer: applied.
    expect(
      await indexer.ingest(await verified(VECTORS.followUnset), 'rebuild', ctx)
    ).toMatchObject({ changes: 1 });
    expect(follow.applied.map((it) => it.change.body)).toEqual([
      { actions: ['DROP_CREATED', 'DROP_REPLIED'] },
      null
    ]);
  });

  it('refuses a body the handler does not accept, before applying anything', async () => {
    const { indexer, follow } = setup();
    const event = record(
      RecordKind.RECORD,
      PS_WAVE,
      ['follow', 'identity:x'],
      { bad: true },
      1000
    );
    await expect(
      indexer.ingest(await verified(event), 'live', ctx)
    ).resolves.toEqual({
      kind: 'refused',
      reason: 'invalid-change',
      detail: 'bad body'
    });
    expect(follow.applied).toHaveLength(0);
  });

  it('refuses bad ciphertext and a bad keys document without throwing', async () => {
    const { indexer, keyring } = setup();
    await indexer.ingest(await verified(VECTORS.keys.event), 'live', ctx);
    const good = Buffer.from(
      (JSON.parse(VECTORS.sealedSettings.event.body!) as { c: string }).c,
      'base64url'
    );
    good[good.length - 1] ^= 1;
    const tampered = record(
      RecordKind.SEALED,
      PV_WAVE,
      ['settings'],
      { c: good.toString('base64url'), v: 1 },
      1000
    );
    expect(await indexer.ingest(await verified(tampered), 'live', ctx)).toEqual(
      expect.objectContaining({ kind: 'refused', reason: 'sealed-format' })
    );
    const badKeys = record(
      RecordKind.SEALED,
      PV_WAVE,
      ['keys'],
      { c: Buffer.from([2, 123]).toString('base64url'), v: 1 },
      1000
    );
    expect(await indexer.ingest(await verified(badKeys), 'live', ctx)).toEqual(
      expect.objectContaining({ kind: 'refused', reason: 'keys-format' })
    );
    expect(keyring.find(PRINCIPAL, inputs.deviceKey, 1, 1)).toEqual(
      hexBytes(inputs.senderKey)
    );
  });

  it('keeps the first sender key when a second one names the same generation', async () => {
    const { indexer, keyring } = setup();
    await indexer.ingest(await verified(VECTORS.keys.event), 'live', ctx);
    const other = wrapSenderKey({
      wave: PV_WAVE,
      cls: SealedClass.PROVIDER,
      gen: 1,
      from: inputs.deviceKey,
      to: `svc:${provider.id}`,
      recipientPublicKey: provider.publicKey,
      senderKey: Buffer.alloc(32, 7)
    });
    const keys = encodeKeysDocument({
      v: 1,
      dev: inputs.deviceKey,
      box: null,
      wraps: [other]
    });
    const event = record(
      RecordKind.SEALED,
      PV_WAVE,
      ['keys'],
      { c: keys.toString('base64url'), v: 1 },
      1000
    );
    expect(await indexer.ingest(await verified(event), 'live', ctx)).toEqual({
      kind: 'keys',
      unwrapped: 0,
      conflicts: 1
    });
    expect(keyring.find(PRINCIPAL, inputs.deviceKey, 1, 1)).toEqual(
      hexBytes(inputs.senderKey)
    );
  });

  it('leaves payload references to the lanes', async () => {
    const { indexer } = setup();
    const event = record(
      RecordKind.SEALED,
      PV_WAVE,
      ['cms'],
      { h: `0x${'a'.repeat(64)}`, n: 2048, v: 1 },
      1000
    );
    expect(await indexer.ingest(await verified(event), 'live', ctx)).toEqual({
      kind: 'skipped',
      reason: 'payload'
    });
  });

  it("locks every head first, then applies in the record's own item order", async () => {
    const { indexer, keyring, mute, heads } = setup(
      new TransactionalHeadStore()
    );
    // A head newer than the record (anchor 1001): that item is stale.
    await heads.put(
      { owner: PRINCIPAL, family: 'pv', type: 'mute', key: 'p5' },
      importOrderKey(2000, 0)
    );
    heads.log.length = 0;
    const settings = await sealedSettings(keyring, [
      { t: 'mute', k: 'p9', b: {} },
      { t: 'mute', k: 'p5', b: {} },
      { t: 'mute', k: 'p1', b: null }
    ]);
    expect(await indexer.ingest(settings, 'live', ctx)).toEqual({
      kind: 'applied',
      changes: 2,
      stale: 1,
      unknown: 0
    });
    // Locks in one sorted order, then each item as the client wrote them.
    expect(heads.log).toEqual([
      'lock p1',
      'lock p5',
      'lock p9',
      'put p9',
      'put p1'
    ]);
    expect(mute.applied.map((it) => it.change.key)).toEqual(['p9', 'p1']);
  });

  it("refuses a record today's rules refuse, with the rule's code, and keeps none of it", async () => {
    const { indexer, keyring, mute, heads } = setup(
      new TransactionalHeadStore()
    );
    mute.failures.set(
      'p9',
      new RecordRuleError('the profile cannot be muted', 'NOT_MUTABLE')
    );
    const settings = await sealedSettings(keyring, [
      { t: 'mute', k: 'p1', b: {} },
      { t: 'mute', k: 'p9', b: {} }
    ]);
    await expect(indexer.ingest(settings, 'live', ctx)).resolves.toEqual({
      kind: 'refused',
      reason: 'rule',
      detail: 'the profile cannot be muted',
      code: 'NOT_MUTABLE'
    });
    // p1 went in before p9 was refused; the transaction took it back.
    expect(heads.log).toContain('put p1');
    expect(heads.heads.size).toBe(0);
  });

  it('throws any other error from apply, after rolling the record back', async () => {
    const { indexer, keyring, mute, heads } = setup(
      new TransactionalHeadStore()
    );
    mute.failures.set('p9', new Error('connection lost'));
    const settings = await sealedSettings(keyring, [
      { t: 'mute', k: 'p1', b: {} },
      { t: 'mute', k: 'p9', b: {} }
    ]);
    await expect(indexer.ingest(settings, 'live', ctx)).rejects.toThrow(
      'connection lost'
    );
    expect(heads.heads.size).toBe(0);
  });

  it('applies each record in one transaction', async () => {
    const { indexer, heads } = setup();
    await indexer.ingest(await verified(VECTORS.followRecord), 'live', ctx);
    expect(heads.transactions).toBe(1);
  });

  it('leaves DEL, unregistered types and other families to the lanes', async () => {
    const { indexer } = setup();
    const del = record(
      RecordKind.DEL,
      PS_WAVE,
      [],
      { ids: [VECTORS.followRecord.id] },
      1000
    );
    expect(await indexer.ingest(await verified(del), 'live', ctx)).toEqual({
      kind: 'skipped',
      reason: 'del'
    });
    const other = record(RecordKind.RECORD, PS_WAVE, ['sub.mode'], {}, 1000);
    expect(await indexer.ingest(await verified(other), 'live', ctx)).toEqual({
      kind: 'skipped',
      reason: 'no-handler'
    });
    const log = record(RecordKind.LOG, 'cv/0x01', ['entry'], {}, 1000);
    expect(await indexer.ingest(await verified(log), 'live', ctx)).toEqual({
      kind: 'skipped',
      reason: 'not-indexed'
    });
  });

  it('refuses to register a type twice', () => {
    const { registry } = setup();
    expect(() =>
      registry.register(new RecordingHandler('ps', 'follow', false))
    ).toThrow('already registered');
  });
});
