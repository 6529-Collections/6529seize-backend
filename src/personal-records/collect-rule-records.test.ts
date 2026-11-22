import {
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException
} from '@/exceptions';
import { RecordChange, RecordRuleError } from '@/signed-records/record-index';
import {
  collectRuleHandlers,
  CollectRecordType,
  CollectRuleDeps,
  SignedCollectRule
} from './collect-rule-records';

const RULE = '00000000-0000-4000-8000-0000000000c1';
const OWNER = `0x${'0'.repeat(63)}1`;
const definition = {
  profile_id: 'profile-1',
  funding_wallet: '0x00000000000000000000000000000000000000b1',
  recipient: '0x00000000000000000000000000000000000000b1',
  plan_id: null,
  analysis_id: null,
  targets: [],
  max_total_cost_wei: '1000',
  max_gas_reserve_wei: '10',
  expires_at: 2_000_000_000_000,
  max_actions: 3
};

const change = (over: Partial<RecordChange> = {}): RecordChange => ({
  owner: OWNER,
  family: 'pv',
  type: CollectRecordType.RULE,
  key: RULE,
  body: { definition, paused: false },
  order: { anchor: 10, claimedTime: 1_700_000_000_000, eventId: '0x01' },
  eventId: '0x01',
  sealedClass: 1,
  writer: 'author',
  ...over
});

function setup(
  opts: {
    profileId?: string | null;
    deferred?: Map<string, SignedCollectRule>;
    applyError?: unknown;
  } = {}
) {
  const calls: { kind: string; args: unknown[] }[] = [];
  const collect: CollectRuleDeps = {
    applyRule: async (...args) => {
      calls.push({ kind: 'apply', args });
      if (opts.applyError) throw opts.applyError;
    },
    restoreRule: async (...args) => {
      calls.push({ kind: 'restoreRule', args });
    },
    restoreOperation: async (...args) => {
      calls.push({ kind: 'restoreOperation', args });
    }
  };
  const handlers = collectRuleHandlers({
    collect,
    profileIdOf: async () =>
      opts.profileId === undefined ? 'profile-1' : opts.profileId,
    deferred: opts.deferred
  });
  const handler = (type: string) => handlers.find((it) => it.type === type)!;
  return { calls, handler };
}

describe('collect.rule records', () => {
  it('applies a signed record (the server keeps the time)', async () => {
    const { calls, handler } = setup();
    const rule = handler(CollectRecordType.RULE);
    rule.validate(change());
    await rule.apply(change(), 'live', {});
    expect(calls).toEqual([
      {
        kind: 'apply',
        args: [
          {
            id: RULE,
            profileId: 'profile-1',
            definition,
            paused: false,
            eventId: '0x01'
          },
          'live',
          {}
        ]
      }
    ]);
  });

  it('changes nothing in a rebuild first pass, or without a profile', async () => {
    for (const opts of [
      { deferred: new Map<string, SignedCollectRule>() },
      { profileId: null }
    ]) {
      const { calls, handler } = setup(opts);
      await handler(CollectRecordType.RULE).apply(change(), 'rebuild', {});
      expect(calls).toEqual([]);
    }
  });

  it('keeps each record as signed in a rebuild first pass, by event id', async () => {
    const deferred = new Map<string, SignedCollectRule>();
    const { handler } = setup({ deferred });
    const rule = handler(CollectRecordType.RULE);
    await rule.apply(change(), 'rebuild', {});
    await rule.apply(
      change({
        eventId: '0x02',
        body: { definition, paused: true }
      }),
      'rebuild',
      {}
    );
    expect(Array.from(deferred.entries())).toEqual([
      [
        '0x01',
        { rule: RULE, profileId: 'profile-1', definition, paused: false }
      ],
      ['0x02', { rule: RULE, profileId: 'profile-1', definition, paused: true }]
    ]);
    // A record with no profile behind its owner is kept as nothing.
    const none = new Map<string, SignedCollectRule>();
    await setup({ deferred: none, profileId: null })
      .handler(CollectRecordType.RULE)
      .apply(change(), 'rebuild', {});
    expect(none.size).toBe(0);
  });

  it('refuses a malformed record', () => {
    const { handler } = setup();
    const rule = handler(CollectRecordType.RULE);
    for (const bad of [
      change({ eventId: null }),
      change({ key: 'not-a-uuid' }),
      change({ body: null }),
      change({ body: { definition, paused: 'yes' } }),
      change({ body: { definition, paused: false, extra: 1 } }),
      change({ body: { definition: [], paused: false } })
    ]) {
      expect(() => rule.validate(bad)).toThrow();
    }
  });

  it("refuses a live record by rule on today's 4xx answers", async () => {
    const cases: [unknown, string][] = [
      [
        new CustomApiCompliantException(409, 'finished', 'X'),
        'COLLECT_RULE_CONFLICT'
      ],
      [new ForbiddenException('not yours'), 'COLLECT_RULE_FORBIDDEN'],
      [new BadRequestException('bad terms'), 'COLLECT_RULE_INVALID']
    ];
    for (const [error, code] of cases) {
      const { handler } = setup({ applyError: error });
      const thrown = await handler(CollectRecordType.RULE)
        .apply(change(), 'live', {})
        .catch((e) => e);
      expect(thrown).toBeInstanceOf(RecordRuleError);
      expect((thrown as RecordRuleError).code).toBe(code);
    }
    const failure = new Error('database down');
    const { handler } = setup({ applyError: failure });
    await expect(
      handler(CollectRecordType.RULE).apply(change(), 'live', {})
    ).rejects.toBe(failure);
  });
});

describe('imported collect rules and operations', () => {
  const imported = (type: string, key: string, body: Record<string, unknown>) =>
    change({ type, key, body, eventId: null });

  it('restores a rule as stored', async () => {
    const { calls, handler } = setup();
    const state = handler(CollectRecordType.RULE_STATE);
    const item = imported(CollectRecordType.RULE_STATE, RULE, {
      rule: { id: RULE, revision: 4 },
      idempotency_key: 'key-1',
      request_hash: 'a'.repeat(64)
    });
    state.validate(item);
    await state.apply(item, 'rebuild', {});
    expect(calls).toEqual([
      {
        kind: 'restoreRule',
        args: [
          {
            rule: { id: RULE, revision: 4 },
            idempotencyKey: 'key-1',
            requestHash: 'a'.repeat(64)
          },
          {}
        ]
      }
    ]);
    expect(() => state.validate({ ...item, eventId: '0x01' })).toThrow(
      'only from the import'
    );
    expect(() =>
      state.validate(
        imported(CollectRecordType.RULE_STATE, RULE, {
          rule: { id: 'another' },
          idempotency_key: 'key-1',
          request_hash: 'a'.repeat(64)
        })
      )
    ).toThrow();
  });

  it('restores an operation binding with its hashes and nonce', async () => {
    const { calls, handler } = setup();
    const op = handler(CollectRecordType.OPERATION);
    const body = {
      rule_id: RULE,
      review_hash: 'b'.repeat(64),
      settlement_hash: null,
      transaction_hash: `0x${'c'.repeat(64)}`,
      transaction_nonce: 3,
      created_at: 5
    };
    const item = imported(CollectRecordType.OPERATION, 'op-1', body);
    op.validate(item);
    await op.apply(item, 'rebuild', {});
    expect(calls[0].args[0]).toEqual({ operation_id: 'op-1', ...body });
    for (const bad of [
      { transaction_hash: 'not-a-hash' },
      { transaction_nonce: -1 },
      { transaction_nonce: 1.5 }
    ]) {
      expect(() =>
        op.validate(
          imported(CollectRecordType.OPERATION, 'op-1', { ...body, ...bad })
        )
      ).toThrow();
    }
    // A hash kept before nonces were: no nonce.
    op.validate(
      imported(CollectRecordType.OPERATION, 'op-1', {
        ...body,
        transaction_nonce: null
      })
    );
  });
});
