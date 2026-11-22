import { signRecordEvent } from './record-event';
import {
  RecordChange,
  RecordIndexer,
  RecordRegistry,
  RecordTypeHandler,
  SenderKeyring
} from './record-index';
import { RecordKind } from './record-kinds';
import { importOrderKey } from './record-order';
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
    this.applied.push({ change, mode });
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

function setup() {
  const registry = new RecordRegistry();
  const follow = new RecordingHandler('ps', 'follow', false);
  const mute = new RecordingHandler('pv', 'mute', true);
  registry.register(follow);
  registry.register(mute);
  const heads = new MemoryHeadStore();
  const keyring = new SenderKeyring([provider]);
  const indexer = new RecordIndexer({ registry, heads, keyring });
  return { registry, follow, mute, heads, keyring, indexer };
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
      items: [
        { t: 'mute', k: 'p9', b: {} },
        { t: 'newer-type', k: 'x', b: {} },
        { t: 'mute', k: 'p9', b: null }
      ]
    });
    const event = record(
      RecordKind.SEALED,
      PV_WAVE,
      ['settings'],
      { c: c.toString('base64url'), v: 1 },
      1001
    );
    expect(await indexer.ingest(await verified(event), 'live', ctx)).toEqual({
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
      sealedClass: null
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
    const log = record(RecordKind.LOG, 'cv/g1', ['entry'], {}, 1000);
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
