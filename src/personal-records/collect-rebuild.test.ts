import type { SentEvidence } from '@/collecting/collecting-rules.chain-check';
import type { CollectLogBody } from '@/collecting/collecting-rules.log';
import { parseCollectLogBody } from '@/collecting/collecting-rules.log';
import type { CollectingRuleDefinition } from '@/collecting/collecting-rules.types';
import { importOrderKey } from '@/signed-records/record-order';
import type { SignedCollectRule } from './collect-rule-records';
import { replayCollectLog } from './personal-rebuild.step';

const RULE = '00000000-0000-4000-8000-0000000000c1';
const HASH = `0x${'ab'.repeat(32)}`;
// The import: anchor 100, at time 10_000.
const IMPORT = importOrderKey(100, 10_000);

const definition = (maxActions = 2) =>
  ({
    profile_id: 'profile-1',
    max_actions: maxActions
  }) as never as CollectingRuleDefinition;

const rule = (
  at: number,
  eventId = '0x01',
  changes: Partial<Extract<CollectLogBody, { kind: 'rule' }>> = {}
): CollectLogBody => ({
  kind: 'rule',
  rule: RULE,
  event_id: eventId,
  profile_id: 'profile-1',
  definition: definition(),
  paused: false,
  at,
  ...changes
});

const signed = (
  changes: Partial<SignedCollectRule> = {}
): SignedCollectRule => ({
  rule: RULE,
  profileId: 'profile-1',
  definition: definition(),
  paused: false,
  ...changes
});

const settle = (at: number): CollectLogBody => ({
  kind: 'settle',
  rule: RULE,
  settlement: {
    operation_id: 'op-1',
    status: 'reverted',
    transaction_hash: HASH,
    recipient: '0x00000000000000000000000000000000000000b1',
    assets: [],
    item_cost_wei: '0',
    gas_cost_wei: '63000'
  },
  settlement_hash: 'f'.repeat(64),
  at
});

const sent = (at: number): CollectLogBody => ({
  kind: 'sent',
  rule: RULE,
  operation_id: 'op-1',
  transaction_hash: HASH,
  nonce: 4,
  at
});

const released = (at: number, hash: string | null): CollectLogBody => ({
  kind: 'released',
  rule: RULE,
  operation_id: 'op-1',
  transaction_hash: hash,
  at
});

const ON_CHAIN: SentEvidence = { transaction: null, receipt: null };

describe('replayCollectLog', () => {
  it('replays what the import does not hold, in logged order', async () => {
    const replayed: string[] = [];
    const result = await replayCollectLog({
      entries: [
        // Its record is ordered before the import: the import holds it.
        rule(9_000, '0x01'),
        // Claimed before the import's time but anchored after it: live
        // applied it after the import, so it is replayed.
        rule(10_500, '0x02'),
        // A server entry before the import's time: the import holds it.
        settle(9_500),
        // A sent hash logged while frozen, before the import: replayed.
        sent(9_800),
        settle(12_000)
      ],
      importOrder: IMPORT,
      records: new Map([
        ['0x01', { anchor: 99, claimedTime: 9_000, eventId: '0x01' }],
        ['0x02', { anchor: 101, claimedTime: 9_900, eventId: '0x02' }]
      ]),
      signed: new Map([['0x02', signed()]]),
      chain: async (hash) => {
        expect(hash).toBe(HASH);
        return ON_CHAIN;
      },
      replay: async (body, evidence) => {
        replayed.push(`${body.kind}@${body.at}${evidence ? '+chain' : ''}`);
      }
    });
    expect(replayed).toEqual(['rule@10500', 'sent@9800', 'settle@12000+chain']);
    expect(result).toEqual({ applied: 3, refused: [] });
  });

  it('refuses a rule entry that is not what the person signed', async () => {
    const result = await replayCollectLog({
      entries: [
        rule(20_000, '0x03'),
        rule(20_000, '0x04'),
        rule(20_000, '0x05', { paused: true }),
        rule(20_000, '0x06', { definition: definition(3) }),
        rule(20_000, '0x07', { profile_id: 'profile-2' }),
        rule(20_000, '0x08', {
          rule: '00000000-0000-4000-8000-0000000000c2'
        })
      ],
      importOrder: IMPORT,
      records: new Map(
        ['0x04', '0x05', '0x06', '0x07', '0x08'].map((id) => [
          id,
          { anchor: 200, claimedTime: 20_000, eventId: id }
        ])
      ),
      signed: new Map(
        ['0x05', '0x06', '0x07', '0x08'].map((id) => [id, signed()])
      ),
      chain: null,
      replay: async () => undefined
    });
    expect(result.applied).toBe(0);
    expect(result.refused.map((it) => it.detail)).toEqual([
      'no verified record 0x03',
      'record 0x04 was not opened as a rule',
      'the entry differs from record 0x05 as signed',
      'the entry differs from record 0x06 as signed',
      'the entry differs from record 0x07 as signed',
      'the entry differs from record 0x08 as signed'
    ]);
  });

  it('checks a settlement and a sent release on Ethereum, or refuses them', async () => {
    const withChain: string[] = [];
    await replayCollectLog({
      entries: [released(20_000, HASH), released(20_000, null)],
      importOrder: null,
      records: new Map(),
      signed: new Map(),
      chain: async () => ON_CHAIN,
      replay: async (body, evidence) => {
        withChain.push(`${body.kind}:${evidence ? 'chain' : 'none'}`);
      }
    });
    expect(withChain).toEqual(['released:chain', 'released:none']);

    const result = await replayCollectLog({
      entries: [settle(30_000), released(30_000, HASH), released(30_000, null)],
      importOrder: null,
      records: new Map(),
      signed: new Map(),
      chain: null,
      replay: async () => {
        throw new Error('No pending purchase to release.');
      }
    });
    expect(result.refused.map((it) => it.detail)).toEqual([
      'no Ethereum source to check it',
      'no Ethereum source to check it',
      'No pending purchase to release.'
    ]);
  });
});

describe('parseCollectLogBody', () => {
  it('takes each kind with exactly its fields', () => {
    for (const body of [
      rule(1),
      settle(2),
      sent(3),
      released(4, null),
      released(4, HASH),
      {
        kind: 'review',
        rule: RULE,
        review: { operation_id: 'op-1' },
        review_hash: 'a'.repeat(64),
        at: 5
      }
    ]) {
      expect(
        parseCollectLogBody(body as unknown as Record<string, unknown>)
      ).toEqual(body);
    }
    for (const bad of [
      { kind: 'mint', rule: RULE, at: 1 },
      { ...rule(1), extra: true },
      { ...rule(1), at: 1.5 },
      { kind: 'released', rule: RULE, operation_id: 'op-1', at: 4 }
    ]) {
      expect(() =>
        parseCollectLogBody(bad as unknown as Record<string, unknown>)
      ).toThrow('Malformed');
    }
  });
});
