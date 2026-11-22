import { RequestContext } from '@/request.context';
import {
  SignedRecordEvent,
  signRecordEvent
} from '@/signed-records/record-event';
import { RecordRegistry } from '@/signed-records/record-index';
import { RecordKind } from '@/signed-records/record-kinds';
import {
  grantSource,
  hexBytes,
  MemoryHeadStore,
  VECTOR_GRANT,
  vectorDeviceKey,
  VECTORS
} from '@/signed-records/record-test-fixtures';
import { importOrderKey, RecordOrderKey } from '@/signed-records/record-order';
import { registerPersonalRecordTypes } from './personal-record-types';
import { PersonalRecordsService } from './personal-records.service';
import {
  FixtureOwnerDirectory,
  MemoryPersonalTables,
  RecordingLiveEffects
} from './personal-records.test-fixtures';

const inputs = VECTORS.inputs;
const PRINCIPAL = inputs.principal;
const TARGET = inputs.target;
const NOW = VECTORS.followRecord.claimed_time;
const provider = {
  id: inputs.providerKeyId,
  privateKey: hexBytes(inputs.providerPrivateKey),
  publicKey: hexBytes(inputs.providerPublicKey)
};

let seq = 1_900_000_000_000;
function record(
  kind: RecordKind,
  wave: string,
  refs: string[],
  body: object | null,
  anchor = 1000
): SignedRecordEvent {
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
      claimedTime: NOW + (seq % 1000)
    },
    vectorDeviceKey()
  );
}

/**
 * Heads and tables in memory with a transaction that rolls back: a throw
 * inside inTransaction restores both, as MySQL would.
 */
class RollbackHeadStore extends MemoryHeadStore {
  constructor(private readonly tables: MemoryPersonalTables) {
    super();
  }

  override async inTransaction<T>(
    ctx: RequestContext,
    fn: (ctx: RequestContext) => Promise<T>
  ): Promise<T> {
    if (ctx.connection) return fn(ctx);
    const heads = new Map(this.heads);
    const tables = structuredCloneTables(this.tables);
    try {
      return await fn({ ...ctx, connection: {} as never });
    } catch (error) {
      this.heads.clear();
      heads.forEach((value, key) => this.heads.set(key, value));
      restoreTables(this.tables, tables);
      throw error;
    }
  }
}

function structuredCloneTables(tables: MemoryPersonalTables) {
  const copy: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(tables)) {
    if (value instanceof Map) {
      copy[name] = new Map(
        Array.from(value.entries()).map(([key, row]) => [
          key,
          row && typeof row === 'object' && 'actions' in row
            ? { ...row, actions: new Set(row.actions) }
            : row
        ])
      );
    } else if (value instanceof Set) {
      copy[name] = new Set(value);
    }
  }
  return copy;
}

function restoreTables(
  tables: MemoryPersonalTables,
  copy: Record<string, unknown>
) {
  for (const [name, value] of Object.entries(copy)) {
    const target = (
      tables as unknown as Record<string, Map<unknown, unknown> | Set<unknown>>
    )[name];
    target.clear();
    if (value instanceof Map && target instanceof Map) {
      value.forEach((row, key) => target.set(key, row));
    } else if (value instanceof Set && target instanceof Set) {
      value.forEach((item) => target.add(item));
    }
  }
}

function setup(
  providers = [provider],
  importOrder: RecordOrderKey | null = null
) {
  const tables = new MemoryPersonalTables();
  const owners = new FixtureOwnerDirectory(
    new Map([
      [PRINCIPAL, 'p-me'],
      [TARGET, 'p-target']
    ]),
    [{ wallet: inputs.author, principal: PRINCIPAL, from: 1 }]
  );
  const deps = { owners, tables, live: new RecordingLiveEffects(tables) };
  const heads = new RollbackHeadStore(tables);
  const logged: string[] = [];
  const service = new PersonalRecordsService({
    grants: grantSource([VECTOR_GRANT]),
    owners,
    anchors: {
      getAnchor: async () => ({
        anchor: 1050,
        headHeight: 1052,
        finalizedTime: NOW,
        maxAnchorLag: 120
      })
    },
    heads,
    registry: registerPersonalRecordTypes(new RecordRegistry(), deps),
    providers: () => providers,
    log: {
      appendEvents: async (lane, events) => {
        logged.push(...events.map((event) => `${lane}:${event.id}`));
      }
    },
    importOrder: async () => importOrder,
    now: () => NOW,
    maxClockSkewMs: 10 * 60 * 1000
  });
  return { service, tables, logged, heads, owners };
}

describe('PersonalRecordsService.submit', () => {
  it('applies a public follow, logs it once, and calls a resubmit stale', async () => {
    const { service, tables, logged } = setup();
    const follow = VECTORS.followRecord;
    expect(await service.submit([follow], 'primary', 'p-me', {})).toEqual([
      { id: follow.id, outcome: 'applied' }
    ]);
    expect(await tables.followActions('p-me', 'IDENTITY', 'p-target')).toEqual([
      'DROP_CREATED'
    ]);
    expect(await service.submit([follow], 'primary', 'p-me', {})).toEqual([
      { id: follow.id, outcome: 'stale' }
    ]);
    expect(logged).toEqual([`personal:${follow.id}`]);
  });

  it("opens sealed settings with the device's keys record from the same submit, whatever the order", async () => {
    const { service, tables, logged } = setup();
    const sealed = VECTORS.sealedSettings.event;
    const keys = VECTORS.keys.event;
    expect(await service.submit([sealed, keys], 'primary', 'p-me', {})).toEqual(
      [
        { id: sealed.id, outcome: 'applied' },
        { id: keys.id, outcome: 'logged' }
      ]
    );
    expect(tables.mutes.has('p-me|p-target')).toBe(true);
    expect(logged).toEqual([`personal:${keys.id}`, `personal:${sealed.id}`]);
    // The keys record is logged once; without it, sealed settings can't open.
    expect(await service.submit([keys], 'primary', 'p-me', {})).toEqual([
      { id: keys.id, outcome: 'stale' }
    ]);
    const fresh = setup();
    expect(
      await fresh.service.submit([sealed], 'primary', 'p-me', {})
    ).toMatchObject([{ outcome: 'refused', reason: 'no-sender-key' }]);
  });

  it("logs a device's keys once, whatever event carries them", async () => {
    const { service, logged } = setup();
    const keys = VECTORS.keys.event;
    const again = record(
      RecordKind.SEALED,
      keys.wave,
      ['keys'],
      JSON.parse(keys.body ?? 'null')
    );
    expect(await service.submit([keys], 'primary', 'p-me', {})).toEqual([
      { id: keys.id, outcome: 'logged' }
    ]);
    expect(await service.submit([again], 'primary', 'p-me', {})).toEqual([
      { id: again.id, outcome: 'stale' }
    ]);
    expect(logged).toEqual([`personal:${keys.id}`]);
  });

  it("refuses a record ordered before the owner's newest applied one", async () => {
    const { service, tables } = setup();
    const newer = record(
      RecordKind.RECORD,
      `ps/${PRINCIPAL}`,
      ['follow', `identity:${TARGET}`],
      { actions: ['DROP_REPLIED'] },
      1010
    );
    expect(await service.submit([newer], 'primary', 'p-me', {})).toMatchObject([
      { outcome: 'applied' }
    ]);
    // Signed earlier (an older anchor), arriving later: a rebuild would
    // apply it first, so live it is refused, not applied over the newer one.
    expect(
      await service.submit(
        [VECTORS.sealedSettings.event, VECTORS.keys.event],
        'primary',
        'p-me',
        {}
      )
    ).toMatchObject([
      { outcome: 'refused', reason: 'out-of-order', code: 'OUT_OF_ORDER' },
      { outcome: 'logged' }
    ]);
    expect(tables.mutes.size).toBe(0);
  });

  it('logs a reader record once', async () => {
    const { service, logged } = setup();
    const reader = record(
      RecordKind.RECORD,
      `pv/${PRINCIPAL}`,
      ['reader', `0x${'5'.repeat(40)}`],
      {}
    );
    expect(await service.submit([reader], 'primary', 'p-me', {})).toEqual([
      { id: reader.id, outcome: 'logged' }
    ]);
    expect(await service.submit([reader], 'primary', 'p-me', {})).toEqual([
      { id: reader.id, outcome: 'stale' }
    ]);
    expect(logged).toHaveLength(1);
  });

  it('rejects a record that fails verification, with the reason', async () => {
    const { service } = setup();
    const stale = record(
      RecordKind.RECORD,
      `ps/${PRINCIPAL}`,
      ['follow', `identity:${TARGET}`],
      { actions: ['DROP_CREATED'] },
      900
    );
    const forged = {
      ...VECTORS.followRecord,
      signature: `0x${'0'.repeat(128)}`
    };
    expect(
      await service.submit([stale, forged, 'junk'], 'primary', 'p-me', {})
    ).toMatchObject([
      { id: stale.id, outcome: 'rejected', reason: 'anchor' },
      { id: forged.id, outcome: 'rejected', reason: 'sig' },
      { id: null, outcome: 'rejected', reason: 'shape' }
    ]);
  });

  it("answers 503 when the gateway can't say whose the author's wallet was", async () => {
    const { service, owners } = setup();
    jest
      .spyOn(owners, 'principalAt')
      .mockRejectedValue(new Error('does not cover height 1050'));
    const thrown = await service
      .submit([VECTORS.followRecord], 'primary', 'p-me', {})
      .catch((error: { code?: string; getStatusCode(): number }) => error);
    expect(thrown).toMatchObject({ code: 'OWNERS_UNAVAILABLE' });
    expect((thrown as { getStatusCode(): number }).getStatusCode()).toBe(503);
  });

  it("refuses another profile's records", async () => {
    const { service, tables } = setup();
    expect(
      await service.submit([VECTORS.followRecord], 'primary', 'p-other', {})
    ).toMatchObject([{ outcome: 'refused', reason: 'not-yours' }]);
    expect(tables.follows.size).toBe(0);
  });

  it("refuses a change today's rules refuse, with its code, and logs nothing", async () => {
    const { service, tables, logged } = setup();
    const follow = record(
      RecordKind.RECORD,
      `ps/${PRINCIPAL}`,
      ['follow', `identity:0x${'0'.repeat(63)}9`],
      { actions: ['DROP_CREATED'] }
    );
    expect(await service.submit([follow], 'primary', 'p-me', {})).toMatchObject(
      [
        {
          id: follow.id,
          outcome: 'refused',
          reason: 'rule',
          code: 'TARGET_NOT_FOUND'
        }
      ]
    );
    expect(tables.follows.size).toBe(0);
    expect(logged).toEqual([]);
  });

  it('refuses types it does not know and kinds it does not take', async () => {
    const { service } = setup();
    const unknown = record(
      RecordKind.RECORD,
      `ps/${PRINCIPAL}`,
      ['subs.mode'],
      {
        automatic: true
      }
    );
    const del = record(RecordKind.DEL, `ps/${PRINCIPAL}`, [], {
      ids: [VECTORS.followRecord.id]
    });
    expect(
      await service.submit([unknown, del], 'primary', 'p-me', {})
    ).toMatchObject([
      { outcome: 'refused', reason: 'no-handler' },
      { outcome: 'refused', reason: 'not-accepted' }
    ]);
  });

  it("runs today's rules in shadow, rolls the check back, and logs", async () => {
    const { service, tables, logged } = setup();
    const bad = record(
      RecordKind.RECORD,
      `ps/${PRINCIPAL}`,
      ['follow', `identity:0x${'0'.repeat(63)}9`],
      { actions: ['DROP_CREATED'] }
    );
    expect(await service.submit([bad], 'shadow', 'p-me', {})).toMatchObject([
      { outcome: 'refused', reason: 'rule', code: 'TARGET_NOT_FOUND' }
    ]);
    expect(tables.follows.size).toBe(0);
    expect(logged).toEqual([]);
  });

  it('checks and logs in shadow mode, and changes no table', async () => {
    const { service, tables, logged } = setup();
    const keys = VECTORS.keys.event;
    const sealed = VECTORS.sealedSettings.event;
    const follow = VECTORS.followRecord;
    expect(
      await service.submit([follow, keys, sealed], 'shadow', 'p-me', {})
    ).toEqual([
      { id: follow.id, outcome: 'applied' },
      { id: keys.id, outcome: 'logged' },
      { id: sealed.id, outcome: 'applied' }
    ]);
    expect(tables.follows.size + tables.mutes.size).toBe(0);
    expect(logged).toHaveLength(3);
  });

  it('calls a setting ordered at or before the import stale, and still logs keys records', async () => {
    const importOrder = importOrderKey(1000, NOW + 100);
    const { service, tables, logged } = setup([provider], importOrder);
    const keys = VECTORS.keys.event;
    expect(
      await service.submit(
        [VECTORS.followRecord, keys, VECTORS.sealedSettings.event],
        'primary',
        'p-me',
        {}
      )
    ).toEqual([
      { id: VECTORS.followRecord.id, outcome: 'stale' },
      { id: keys.id, outcome: 'logged' },
      { id: VECTORS.sealedSettings.event.id, outcome: 'stale' }
    ]);
    expect(tables.follows.size + tables.mutes.size).toBe(0);
    expect(logged).toEqual([`personal:${keys.id}`]);
    // A record after the import applies.
    const after = record(
      RecordKind.RECORD,
      `ps/${PRINCIPAL}`,
      ['follow', `identity:${TARGET}`],
      { actions: ['DROP_CREATED'] },
      1001
    );
    expect(await service.submit([after], 'primary', 'p-me', {})).toEqual([
      { id: after.id, outcome: 'applied' }
    ]);
  });

  it('refuses keys records while no provider key is configured', async () => {
    const { service } = setup([]);
    expect(
      await service.submit([VECTORS.keys.event], 'primary', 'p-me', {})
    ).toMatchObject([{ outcome: 'refused', reason: 'provider-unavailable' }]);
  });
});
