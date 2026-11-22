import { SignedRecordEvent, signRecordEvent } from './record-event';
import { RecordKind } from './record-kinds';
import {
  bindingSource,
  grantSource,
  VECTOR_GRANT,
  vectorDeviceKey,
  VECTORS
} from './record-test-fixtures';
import {
  RecordRejectReason,
  RecordVerifyContext,
  VerifiedGrant,
  verifyRecordEvent
} from './record-verify';

const inputs = VECTORS.inputs;
const PRINCIPAL = inputs.principal;
const OTHER = inputs.target;

function context(
  overrides: Partial<RecordVerifyContext> & {
    grant?: Partial<VerifiedGrant>;
  } = {}
): RecordVerifyContext {
  return {
    grants: grantSource([{ ...VECTOR_GRANT, ...overrides.grant }]),
    bindings: bindingSource([
      { wallet: inputs.author, principal: PRINCIPAL, from: 1 }
    ]),
    ...overrides
  };
}

async function reason(
  event: unknown,
  ctx = context()
): Promise<RecordRejectReason | 'ok'> {
  const result = await verifyRecordEvent(event, ctx);
  return result.ok ? 'ok' : result.reason;
}

function resign(
  base: SignedRecordEvent,
  changes: Partial<{
    kind: SignedRecordEvent['kind'];
    wave: string;
    refs: string[];
    body: object | null;
    anchor: number;
    claimedTime: number;
    seq: number;
  }>
): SignedRecordEvent {
  return signRecordEvent(
    {
      kind: changes.kind ?? base.kind,
      wave: changes.wave ?? base.wave,
      refs: changes.refs ?? [...base.refs],
      body:
        changes.body === undefined
          ? (JSON.parse(base.body ?? 'null') as object | null)
          : changes.body,
      author: base.author,
      deviceKey: base.device_key,
      authRef: base.auth_ref,
      seq: changes.seq ?? base.seq,
      anchor: changes.anchor ?? base.anchor,
      claimedTime: changes.claimedTime ?? base.claimed_time
    },
    vectorDeviceKey()
  );
}

describe('verifyRecordEvent', () => {
  it('accepts every vector record', async () => {
    for (const event of [
      VECTORS.followRecord,
      VECTORS.followUnset,
      VECTORS.sealedSettings.event,
      VECTORS.keys.event
    ]) {
      const result = await verifyRecordEvent(event, context());
      expect(result).toMatchObject({
        ok: true,
        record: {
          owner: PRINCIPAL,
          principal: PRINCIPAL,
          order: {
            anchor: event.anchor,
            claimedTime: event.claimed_time,
            eventId: event.id
          }
        }
      });
    }
  });

  it('signs exactly the vector bytes', () => {
    expect(resign(VECTORS.followRecord, {})).toEqual(VECTORS.followRecord);
    expect(resign(VECTORS.followUnset, {})).toEqual(VECTORS.followUnset);
  });

  it('names the reason for a tampered record', async () => {
    const follow = VECTORS.followRecord;
    expect(await reason({ ...follow, seq: follow.seq + 1 })).toBe('id');
    expect(
      await reason({ ...follow, body: '{"actions":["WAVE_CREATED"]}' })
    ).toBe('body');
    expect(
      await reason({
        ...follow,
        signature: VECTORS.followUnset.signature
      })
    ).toBe('sig');
    expect(await reason({ ...follow, kind: 1 })).toBe('kind');
    expect(await reason({ ...follow, extra: true })).toBe('shape');
    expect(await reason({ ...follow, wave: 'some-drop-wave' })).toBe('family');
  });

  it('checks refs and bodies by kind', async () => {
    const follow = VECTORS.followRecord;
    expect(await reason(resign(follow, { refs: [] }))).toBe('refs');
    expect(await reason(resign(follow, { refs: ['Follow', 'k'] }))).toBe(
      'refs'
    );
    expect(await reason(resign(follow, { refs: ['a', 'b', 'c'] }))).toBe(
      'refs'
    );
    expect(
      await reason(resign(follow, { body: { big: 'x'.repeat(17_000) } }))
    ).toBe('size');
    expect(
      await reason(
        resign(follow, {
          kind: RecordKind.SEALED,
          refs: ['settings'],
          body: { c: 'AQ', v: 2 }
        })
      )
    ).toBe('body');
    expect(
      await reason(
        resign(follow, {
          kind: RecordKind.DEL,
          refs: [],
          body: { ids: [VECTORS.followUnset.id] }
        })
      )
    ).toBe('ok');
    expect(
      await reason(
        resign(follow, { kind: RecordKind.DEL, refs: [], body: { ids: [] } })
      )
    ).toBe('body');
  });

  it('refuses a body that is not canonical JSON', async () => {
    const follow = VECTORS.followRecord;
    const spaced = '{"actions": ["DROP_CREATED"]}';
    const event = { ...follow, body: spaced };
    expect(await reason(event)).toBe('body');
  });

  it('checks the grant', async () => {
    const follow = VECTORS.followRecord;
    expect(
      await reason(follow, { ...context(), grants: grantSource([]) })
    ).toBe('grant-unknown');
    expect(
      await reason(
        follow,
        context({ grant: { wallet: `0x${'2'.repeat(40)}` } })
      )
    ).toBe('grant-key');
    expect(
      await reason(follow, context({ grant: { scopes: ['react'] } }))
    ).toBe('grant-scope');
    expect(
      await reason(
        follow,
        context({ grant: { expiresAt: follow.claimed_time } })
      )
    ).toBe('grant-expired');
    expect(
      await reason(
        follow,
        context({ grant: { revokedAt: follow.claimed_time - 1 } })
      )
    ).toBe('grant-revoked');
    // Signed before the revocation: still valid when replayed.
    expect(
      await reason(
        follow,
        context({ grant: { revokedAt: follow.claimed_time } })
      )
    ).toBe('ok');
  });

  it('checks the binding at the anchor', async () => {
    const follow = VECTORS.followRecord;
    const boundLater = bindingSource([
      { wallet: inputs.author, principal: PRINCIPAL, from: follow.anchor + 1 }
    ]);
    expect(await reason(follow, { ...context(), bindings: boundLater })).toBe(
      'not-bound'
    );
    expect(await reason(resign(follow, { wave: `ps/${OTHER}` }))).toBe(
      'not-bound'
    );
    expect(await reason(resign(follow, { anchor: 0 }))).toBe('anchor');
  });

  it('checks a live submission against now and the head', async () => {
    const follow = VECTORS.followRecord;
    const live = {
      now: follow.claimed_time + 1000,
      head: follow.anchor + 10,
      maxAnchorLag: 100,
      maxClockSkewMs: 10 * 60 * 1000
    };
    expect(await reason(follow, context({ live }))).toBe('ok');
    expect(
      await reason(
        follow,
        context({ live: { ...live, head: follow.anchor - 1 } })
      )
    ).toBe('anchor');
    expect(
      await reason(follow, context({ live: { ...live, maxAnchorLag: 5 } }))
    ).toBe('anchor');
    expect(
      await reason(
        follow,
        context({
          live: { ...live, now: follow.claimed_time + 11 * 60 * 1000 }
        })
      )
    ).toBe('anchor');
    // Live, any revocation refuses, whatever the claimed time.
    expect(
      await reason(
        follow,
        context({ live, grant: { revokedAt: follow.claimed_time + 1 } })
      )
    ).toBe('grant-revoked');
  });

  it('returns the author principal for lane-owned families', async () => {
    const event = resign(VECTORS.followRecord, {
      kind: RecordKind.LOG,
      wave: 'cv/group-1',
      refs: ['entry'],
      body: { seq: 1 }
    });
    const result = await verifyRecordEvent(event, context());
    expect(result).toMatchObject({
      ok: true,
      record: { family: 'cv', owner: 'group-1', principal: PRINCIPAL }
    });
  });
});

describe('families, writers and strings', () => {
  const follow = VECTORS.followRecord;
  const PV = `pv/${PRINCIPAL}`;
  const sealed = { c: 'AQ', v: 1 };

  it('refuses kinds and record types a family does not carry', async () => {
    // A sealed item in a public stream, a log anywhere but cv, any RECORD
    // type but reader in pv.
    expect(
      await reason(
        resign(follow, {
          kind: RecordKind.SEALED,
          refs: ['settings'],
          body: sealed
        })
      )
    ).toBe('family');
    expect(
      await reason(
        resign(follow, { kind: RecordKind.LOG, refs: ['entry'], body: {} })
      )
    ).toBe('family');
    expect(await reason(resign(follow, { wave: PV }))).toBe('family');
    expect(
      await reason(
        resign(follow, { wave: 'dr/0x01', refs: ['mls-device', 'k'], body: {} })
      )
    ).toBe('ok');
    expect(
      await reason(
        resign(follow, { wave: 'dr/0x01', refs: ['follow', 'k'], body: {} })
      )
    ).toBe('family');
    expect(
      await reason(
        resign(follow, {
          kind: RecordKind.DEL,
          wave: 'cv/g1',
          refs: [],
          body: { ids: [follow.id] }
        })
      )
    ).toBe('family');
  });

  it('takes a reader record in pv only when it names a wallet', async () => {
    const reader = (key: string) =>
      resign(follow, { wave: PV, refs: ['reader', key], body: {} });
    expect(await reason(reader(`0x${'5'.repeat(40)}`))).toBe('ok');
    expect(await reason(reader('someone'))).toBe('refs');
  });

  it('lets the orderer write into pv and bk but not ps', async () => {
    const otherPrincipal = `0x${'0'.repeat(63)}9`;
    const ctx = {
      ...context(),
      ordererWallets: [inputs.author.toUpperCase().replace('0X', '0x')]
    };
    const intoPv = resign(follow, {
      kind: RecordKind.SEALED,
      wave: `pv/${otherPrincipal}`,
      refs: ['cms'],
      body: sealed
    });
    expect(await verifyRecordEvent(intoPv, ctx)).toMatchObject({
      ok: true,
      record: { writer: 'orderer', owner: otherPrincipal, principal: PRINCIPAL }
    });
    expect(await reason(intoPv)).toBe('not-bound');
    expect(
      await reason(resign(follow, { wave: `ps/${otherPrincipal}` }), ctx)
    ).toBe('not-bound');
    const own = await verifyRecordEvent(follow, ctx);
    expect(own).toMatchObject({ ok: true, record: { writer: 'author' } });
  });

  it('takes a public stream owned by a bare wallet from that wallet while it is unbound', async () => {
    const walletStream = resign(follow, {
      wave: `ps/${inputs.author}`,
      refs: ['subs.mode'],
      body: { automatic: true }
    });
    const unbound = { ...context(), bindings: bindingSource([]) };
    expect(await verifyRecordEvent(walletStream, unbound)).toMatchObject({
      ok: true,
      record: { owner: inputs.author, principal: null, writer: 'author' }
    });
    // Bound to a principal at the anchor: its records go to ps/<principal>.
    expect(await reason(walletStream)).toBe('not-bound');
    expect(
      await reason(resign(follow, { wave: `ps/0x${'7'.repeat(40)}` }), unbound)
    ).toBe('not-bound');
    expect(await reason(resign(follow, { wave: `pv/${inputs.author}` }))).toBe(
      'family'
    );
  });

  it('parses sealed payload references', async () => {
    const ref = resign(follow, {
      kind: RecordKind.SEALED,
      wave: PV,
      refs: ['welcome'],
      body: { h: `0x${'a'.repeat(64)}`, n: 4096, v: 1 }
    });
    expect(await verifyRecordEvent(ref, context())).toMatchObject({
      ok: true,
      record: {
        parsed: {
          bytes: null,
          payload: { sha256: `0x${'a'.repeat(64)}`, size: 4096 }
        }
      }
    });
    const tooBig = resign(follow, {
      kind: RecordKind.SEALED,
      wave: PV,
      refs: ['welcome'],
      body: { h: `0x${'a'.repeat(64)}`, n: 5 * 1024 * 1024, v: 1 }
    });
    expect(await reason(tooBig)).toBe('body');
  });

  it('refuses lone surrogates instead of throwing', async () => {
    expect(await reason({ ...follow, refs: ['follow', '\uD800x'] })).toBe(
      'shape'
    );
    expect(await reason({ ...follow, wave: `ps/${PRINCIPAL}\uDC00` })).toBe(
      'shape'
    );
    expect(await reason({ ...follow, body: '{"actions":["\uD800"]}' })).toBe(
      'shape'
    );
  });
});
