import 'reflect-metadata';
import { id as eventTopic, zeroPadValue } from 'ethers';
import { collectingAssetKey } from '@/collecting/collecting-analysis';
import type {
  NonceTransaction,
  SentEvidence,
  SentTransaction,
  SettlementReceipt
} from '@/collecting/collecting-rules.chain-check';
import type { CollectRulesJournal } from '@/collecting/collecting-rules.journal';
import type { CollectLogBody } from '@/collecting/collecting-rules.log';
import {
  COLLECT_RULE_OPERATIONS_TABLE,
  COLLECT_RULES_TABLE,
  CollectingRulesService
} from '@/collecting/collecting-rules.service';
import {
  CollectingRuleDefinition,
  CollectingRuleReview,
  CollectingRuleSettlement
} from '@/collecting/collecting-rules.types';
import { MEMES_CONTRACT } from '@/constants';
import { MARKET_SEAPORT } from '@/marketplace/seaport.registry';
import type { SignedCollectRule } from '@/personal-records/collect-rule-records';
import { replayCollectLog } from '@/personal-records/personal-rebuild.step';
import { importOrderKey, RecordOrderKey } from '@/signed-records/record-order';
import { dbSupplier, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';

const START = Date.parse('2026-09-01T12:00:00Z');
const WALLET = '0x0000000000000000000000000000000000000011';
const RECIPIENT = '0x0000000000000000000000000000000000000022';
const OTHER = '0x0000000000000000000000000000000000000033';
const ASSET = collectingAssetKey(MEMES_CONTRACT, '1');
const RULE_A = '00000000-0000-4000-8000-00000000000a';
const RULE_B = '00000000-0000-4000-8000-00000000000b';
const SENT_1 = `0x${'1'.repeat(64)}`;
const SENT_2 = `0x${'2'.repeat(64)}`;
const SENT_3 = `0x${'3'.repeat(64)}`;

const definition = (): CollectingRuleDefinition => ({
  profile_id: 'profile-1',
  funding_wallet: WALLET,
  recipient: RECIPIENT,
  plan_id: null,
  analysis_id: null,
  targets: [
    { asset_key: ASSET, target_quantity: '3', maximum_unit_price_wei: '100' }
  ],
  max_total_cost_wei: '1000000',
  max_gas_reserve_wei: '100000',
  expires_at: START + 86_400_000,
  max_actions: 5
});

const review = (
  operationId: string,
  at: number,
  quantity = '1'
): CollectingRuleReview => ({
  operation_id: operationId,
  quote_id: `quote-${operationId}`,
  profile_id: 'profile-1',
  funding_wallet: WALLET,
  recipient: RECIPIENT,
  valid_until: at + 20_000,
  assets: [{ asset_key: ASSET, quantity, unit_price_wei: '100' }],
  item_cost_wei: (BigInt(100) * BigInt(quantity)).toString(),
  gas_reserve_wei: '70000'
});

const confirmed = (
  operationId: string,
  hash = SENT_1,
  quantity = '1'
): CollectingRuleSettlement => ({
  operation_id: operationId,
  status: 'confirmed',
  transaction_hash: hash,
  recipient: RECIPIENT,
  assets: [{ asset_key: ASSET, quantity }],
  item_cost_wei: (BigInt(100) * BigInt(quantity)).toString(),
  gas_cost_wei: '63000'
});

/** The receipt of a purchase that delivered `quantity` to the recipient. */
const delivered = (quantity: number) => ({
  status: 1,
  gasUsed: BigInt(21_000),
  gasPrice: BigInt(3),
  logs: [
    {
      address: MEMES_CONTRACT.toLowerCase(),
      topics: [
        eventTopic('TransferSingle(address,address,address,uint256,uint256)'),
        zeroPadValue(OTHER, 32),
        zeroPadValue(OTHER, 32),
        zeroPadValue(RECIPIENT, 32)
      ],
      data: `0x${'1'.padStart(64, '0')}${quantity.toString(16).padStart(64, '0')}`
    }
  ]
});

/** Another transaction at the purchase's nonce 4: a cancel to itself. */
const cancel = (): NonceTransaction => ({
  hash: SENT_3,
  transaction: { from: WALLET, to: WALLET, value: BigInt(0), nonce: 4 },
  receipt: { ...delivered(0), logs: [] }
});

// Every purchase in these tests is sent at nonce 4.
const purchase = (value: number, from = WALLET): SentTransaction => ({
  from,
  to: MARKET_SEAPORT,
  value: BigInt(value),
  nonce: 4
});

describeWithSeed('Collect rules from records and the collect lane', [], () => {
  let clock = START;
  let logged: CollectLogBody[] = [];
  let primary = true;
  let frozen = false;
  // What Ethereum shows for each hash the tests send, and the funding
  // wallet's next nonce on a safe block.
  let chain: Record<string, SentEvidence> = {};
  let mined = 0;
  // The transaction that used the purchase's nonce, once it is used.
  let usedNonce: NonceTransaction | null = null;
  const journal: CollectRulesJournal = {
    enabled: () => primary,
    frozen: async () => frozen,
    append: async (body) => {
      // As the log stores it: canonical JSON, read back.
      logged.push(JSON.parse(JSON.stringify(body)));
    }
  };
  const service = new CollectingRulesService(
    dbSupplier,
    () => clock,
    journal,
    async (hash) => chain[hash]?.transaction ?? null
  );
  const at = (step: number) => {
    clock = START + step * 1_000;
    return clock;
  };
  // Every rule record is anchored at 1000 + its step; signed as logged.
  const orders = new Map<string, RecordOrderKey>();
  const signed = new Map<string, SignedCollectRule>();
  const record = (
    id: string,
    paused: boolean,
    step: number,
    eventId: string
  ) => {
    at(step);
    orders.set(eventId, {
      anchor: 1000 + step,
      claimedTime: clock,
      eventId
    });
    signed.set(eventId, {
      rule: id,
      profileId: 'profile-1',
      definition: definition(),
      paused
    });
    return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      service.applyRuleRecord(
        {
          id,
          profileId: 'profile-1',
          definition: definition(),
          paused,
          eventId
        },
        connection
      )
    );
  };
  const sent = (operationId: string, hash: string, value = 100) => {
    chain[hash] = { transaction: purchase(value), receipt: null };
    return service.recordSent(operationId, hash);
  };

  const answers = async () => ({
    rules: await service.list('profile-1', 100),
    operations: await sqlExecutor.execute(
      `select operation_id, rule_id, review_hash, settlement_hash, transaction_hash, transaction_nonce, created_at
       from ${COLLECT_RULE_OPERATIONS_TABLE} order by operation_id`
    )
  });

  const emptyTables = async () => {
    await sqlExecutor.execute(`delete from ${COLLECT_RULE_OPERATIONS_TABLE}`);
    await sqlExecutor.execute(`delete from ${COLLECT_RULES_TABLE}`);
  };

  const replay = (
    entries: readonly CollectLogBody[],
    importOrder: RecordOrderKey | null = null
  ) =>
    replayCollectLog({
      entries,
      importOrder,
      records: orders,
      signed,
      chain: async (hash) => ({
        ...(chain[hash] ?? { transaction: null, receipt: null }),
        minedNonce: async () => mined,
        nonceTransaction: async () => usedNonce
      }),
      replay: (body, evidence) =>
        sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          service.replay(body, connection, evidence)
        )
    });

  beforeEach(() => {
    clock = START;
    logged = [];
    primary = true;
    frozen = false;
    chain = {};
    mined = 0;
    usedNonce = null;
    orders.clear();
    signed.clear();
  });

  it('rebuilds the same rules from the lane, with orders mid-flight', async () => {
    // Live, in primary: records and the server's facts, all logged.
    await record(RULE_A, false, 1, '0xa1');
    await record(RULE_A, true, 2, '0xa2');
    await record(RULE_A, false, 3, '0xa3');
    at(4);
    await service.reserveReview(RULE_A, 'profile-1', review('op-1', clock));
    at(5);
    await sent('op-1', SENT_1);
    at(6);
    chain[SENT_1] = { transaction: purchase(100), receipt: delivered(1) };
    await service.settle(RULE_A, 'profile-1', confirmed('op-1'), chain[SENT_1]);
    // Mid-flight, sent: the rule keeps the hash.
    at(7);
    await service.reserveReview(RULE_A, 'profile-1', review('op-2', clock));
    at(8);
    await sent('op-2', SENT_2);
    // Mid-flight, never sent.
    await record(RULE_B, false, 9, '0xb1');
    at(10);
    await service.reserveReview(RULE_B, 'profile-1', review('op-3', clock));
    // A record repeating the current state changes and logs nothing.
    const before = logged.length;
    await record(RULE_A, false, 11, '0xa4');
    expect(logged.length).toBe(before);

    const live = await answers();
    expect(logged.map((body) => body.kind)).toEqual([
      'rule',
      'rule',
      'rule',
      'review',
      'sent',
      'settle',
      'review',
      'sent',
      'rule',
      'review'
    ]);
    // Every entry carries the server's time.
    expect(logged.map((body) => body.at)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((step) => START + step * 1_000)
    );

    await emptyTables();
    at(1_000);
    const result = await replay(logged);
    expect(result).toEqual({ applied: logged.length, refused: [] });
    clock = START + 11_000;
    expect(await answers()).toEqual(live);

    // After the rebuild the market journal is gone.
    const [ruleA, ruleB] = [
      live.rules.find((rule) => rule.id === RULE_A)!,
      live.rules.find((rule) => rule.id === RULE_B)!
    ];
    expect(ruleA.pending_review?.operation_id).toBe('op-2');
    expect((await service.findOperation('op-2'))?.transaction_hash).toBe(
      SENT_2
    );
    // The sent one is never released without its hash...
    await expect(service.release(RULE_A, 'profile-1', 'op-2')).rejects.toThrow(
      'reconcile it instead'
    );
    // ...the unsent one is released once its quote expired.
    expect(ruleB.pending_review?.operation_id).toBe('op-3');
    await expect(service.release(RULE_B, 'profile-1', 'op-3')).rejects.toThrow(
      'can still be sent'
    );
    at(100);
    const released = await service.release(RULE_B, 'profile-1', 'op-3');
    expect(released.pending_review).toBeNull();
    expect(released.review_count).toBe(1);
    expect(released.revision).toBe(ruleB.revision + 1);
    expect(logged[logged.length - 1]).toEqual({
      kind: 'released',
      rule: RULE_B,
      operation_id: 'op-3',
      transaction_hash: null,
      at: clock
    });
  });

  it("refuses a record that changes a rule's terms or creates it paused", async () => {
    await record(RULE_A, false, 1, '0xc1');
    at(2);
    await expect(
      sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        service.applyRuleRecord(
          {
            id: RULE_A,
            profileId: 'profile-1',
            definition: { ...definition(), max_actions: 4 },
            paused: true,
            eventId: '0xc2'
          },
          connection
        )
      )
    ).rejects.toThrow("terms can't change");
    await expect(record(RULE_B, true, 3, '0xc3')).rejects.toThrow(
      'starts active'
    );
  });

  it("judges a rule record by the server's time", async () => {
    // A record for a rule that has expired by the server's clock.
    at(1);
    await expect(
      sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        service.applyRuleRecord(
          {
            id: RULE_A,
            profileId: 'profile-1',
            definition: { ...definition(), expires_at: START },
            paused: false,
            eventId: '0xe1'
          },
          connection
        )
      )
    ).rejects.toThrow();
    await record(RULE_A, false, 2, '0xe2');
    const [rule] = await service.list('profile-1', 10);
    expect(rule.created_at).toBe(START + 2_000);
    expect(logged[0]).toMatchObject({ kind: 'rule', at: START + 2_000 });
  });

  it('restores an imported rule and binding as stored', async () => {
    await record(RULE_A, false, 1, '0xd1');
    at(2);
    await service.reserveReview(RULE_A, 'profile-1', review('op-9', clock));
    const live = await answers();
    const [row] = await sqlExecutor.execute<Record<string, unknown>>(
      `select * from ${COLLECT_RULES_TABLE} where id = :id`,
      { id: RULE_A }
    );
    await emptyTables();
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await service.restoreRule(
        {
          rule: live.rules[0],
          idempotencyKey: String(row.idempotency_key),
          requestHash: String(row.request_hash)
        },
        connection
      );
      await service.restoreOperation(live.operations[0] as never, connection);
    });
    expect(await answers()).toEqual(live);
  });

  it('replays a rule record anchored after the import though claimed before it', async () => {
    await record(RULE_A, false, 1, '0xf1');
    // The import: anchor 1001, time START + 1500. The record's anchor is
    // 1001 + 1, its claimed time START + 1000, before the import's.
    orders.set('0xf1', {
      anchor: 1002,
      claimedTime: START + 1_000,
      eventId: '0xf1'
    });
    const live = await answers();
    await emptyTables();
    expect(await replay(logged, importOrderKey(1001, START + 1_500))).toEqual({
      applied: 1,
      refused: []
    });
    expect(await answers()).toEqual(live);
    // Ordered at or before the import: the import holds it.
    await emptyTables();
    expect(await replay(logged, importOrderKey(1002, START + 2_000))).toEqual({
      applied: 0,
      refused: []
    });
  });

  it('refuses a rule entry that is not what the person signed', async () => {
    await record(RULE_A, false, 1, '0xf2');
    signed.set('0xf2', { ...signed.get('0xf2')!, paused: true });
    await emptyTables();
    const result = await replay(logged);
    expect(result.refused).toEqual([
      {
        what: `collect rule ${RULE_A}`,
        detail: 'the entry differs from record 0xf2 as signed'
      }
    ]);
    expect(await service.list('profile-1', 10)).toEqual([]);
  });

  it('refuses only a sent hash Ethereum shows as another transaction', async () => {
    await record(RULE_A, false, 1, '0xg1');
    at(2);
    await service.reserveReview(RULE_A, 'profile-1', review('op-1', clock));
    for (const [transaction, problem] of [
      [purchase(100, OTHER), 'funding wallet'],
      [{ ...purchase(100), to: OTHER }, 'market contract'],
      [purchase(99), 'reviewed cost']
    ] as const) {
      chain[SENT_1] = { transaction, receipt: null };
      await expect(service.recordSent('op-1', SENT_1)).rejects.toThrow(problem);
    }
    expect((await service.findOperation('op-1'))?.transaction_hash).toBeNull();
    expect(logged.map((body) => body.kind)).toEqual(['rule', 'review']);
  });

  it('keeps a hash Ethereum does not show yet, unchecked, and checks it later', async () => {
    await record(RULE_A, false, 1, '0xg2');
    at(2);
    await service.reserveReview(RULE_A, 'profile-1', review('op-1', clock));
    // Just broadcast, or sent privately: not seen yet. Kept, and logged
    // unchecked with no nonce.
    at(3);
    chain[SENT_1] = { transaction: null, receipt: null };
    await service.recordSent('op-1', SENT_1);
    const kept = await service.findOperation('op-1');
    expect([kept?.transaction_hash, kept?.transaction_nonce]).toEqual([
      SENT_1,
      null
    ]);
    expect(logged[logged.length - 1]).toEqual({
      kind: 'sent',
      rule: RULE_A,
      operation_id: 'op-1',
      transaction_hash: SENT_1,
      nonce: null,
      at: START + 3_000
    });
    // Asked again while still unseen: nothing new.
    const before = logged.length;
    await service.recordSent('op-1', SENT_1);
    expect(logged.length).toBe(before);
    // Seen now (reconcile asks again): kept with its nonce, logged again.
    at(4);
    chain[SENT_1] = { transaction: purchase(100), receipt: null };
    await service.recordSent('op-1', SENT_1);
    expect(
      Number((await service.findOperation('op-1'))?.transaction_nonce)
    ).toBe(4);
    expect(logged[logged.length - 1]).toEqual({
      kind: 'sent',
      rule: RULE_A,
      operation_id: 'op-1',
      transaction_hash: SENT_1,
      nonce: 4,
      at: START + 4_000
    });
    // Checked once: asking again logs nothing.
    await service.recordSent('op-1', SENT_1);
    expect(logged.length).toBe(before + 1);
    // The rebuild replays both entries to the same binding.
    const live = await answers();
    await emptyTables();
    expect((await replay(logged)).refused).toEqual([]);
    expect(await answers()).toEqual(live);
  });

  it('settles live only what a rebuild would accept', async () => {
    await record(RULE_A, false, 1, '0xg3');
    at(2);
    await service.reserveReview(
      RULE_A,
      'profile-1',
      review('op-1', clock, '2')
    );
    at(3);
    await sent('op-1', SENT_1, 200);
    // A partial fill: one of two delivered. The full cost against it is
    // refused; the reviewed unit price times one is not.
    chain[SENT_1] = { transaction: purchase(200), receipt: delivered(1) };
    at(4);
    const logs = logged.length;
    await expect(
      service.settle(
        RULE_A,
        'profile-1',
        { ...confirmed('op-1', SENT_1, '1'), item_cost_wei: '200' },
        chain[SENT_1]
      )
    ).rejects.toThrow('item cost');
    // With nothing from Ethereum, nothing is settled either.
    await expect(
      service.settle(RULE_A, 'profile-1', confirmed('op-1', SENT_1, '1'))
    ).rejects.toThrow('nothing from Ethereum');
    expect(logged.length).toBe(logs);
    const [rule] = await service.list('profile-1', 10);
    expect(rule.pending_review?.operation_id).toBe('op-1');
  });

  it("checks a settlement's payment and delivery on rebuild", async () => {
    await record(RULE_A, false, 1, '0xh1');
    at(2);
    await service.reserveReview(RULE_A, 'profile-1', review('op-1', clock));
    at(3);
    await sent('op-1', SENT_1);
    at(4);
    chain[SENT_1] = { transaction: purchase(100), receipt: delivered(1) };
    await service.settle(RULE_A, 'profile-1', confirmed('op-1'), chain[SENT_1]);
    for (const [evidence, problem] of [
      [{ transaction: purchase(100), receipt: delivered(0) }, 'did not reach'],
      [{ transaction: purchase(99), receipt: delivered(1) }, 'reviewed cost'],
      [
        { transaction: purchase(100, OTHER), receipt: delivered(1) },
        'funding wallet'
      ],
      [{ transaction: purchase(100), receipt: null }, 'no receipt']
    ] as const) {
      chain[SENT_1] = evidence;
      await emptyTables();
      const result = await replay(logged);
      expect(result.refused).toEqual([
        {
          what: `collect settle ${RULE_A}`,
          detail: expect.stringContaining(problem)
        }
      ]);
      const [rule] = await service.list('profile-1', 10);
      expect(rule.pending_review?.operation_id).toBe('op-1');
    }
  });

  it('settles a partial fill and replays it the same', async () => {
    await record(RULE_A, false, 1, '0xi1');
    at(2);
    await service.reserveReview(
      RULE_A,
      'profile-1',
      review('op-1', clock, '2')
    );
    at(3);
    await sent('op-1', SENT_1, 200);
    chain[SENT_1] = { transaction: purchase(200), receipt: delivered(1) };
    at(4);
    await service.settle(
      RULE_A,
      'profile-1',
      confirmed('op-1', SENT_1, '1'),
      chain[SENT_1]
    );
    const live = await answers();
    expect(live.rules[0].acquired).toEqual([
      { asset_key: ASSET, quantity: '1' }
    ]);
    expect(live.rules[0].spent_item_cost_wei).toBe('100');
    await emptyTables();
    expect((await replay(logged)).refused).toEqual([]);
    expect(await answers()).toEqual(live);
  });

  it('releases a sent purchase only once its nonce is used by another, and replays it the same way', async () => {
    const unmined = (
      receipt: SettlementReceipt | null,
      minedNonce: number,
      transactionHash = SENT_1
    ) => ({
      transactionHash,
      evidence: {
        transaction: null,
        receipt,
        minedNonce: async () => minedNonce,
        nonceTransaction: async () => cancel()
      }
    });
    await record(RULE_A, false, 1, '0xj1');
    at(2);
    const reviewed = review('op-1', clock);
    await service.reserveReview(RULE_A, 'profile-1', reviewed);
    at(3);
    await sent('op-1', SENT_1);
    // The nonce is kept with the hash, and logged.
    expect(
      Number((await service.findOperation('op-1'))?.transaction_nonce)
    ).toBe(4);
    expect(logged[logged.length - 1]).toEqual({
      kind: 'sent',
      rule: RULE_A,
      operation_id: 'op-1',
      transaction_hash: SENT_1,
      nonce: 4,
      at: START + 3_000
    });
    // Not while the quote can still be used.
    await expect(
      service.release(RULE_A, 'profile-1', 'op-1', unmined(null, 5))
    ).rejects.toThrow('can still be sent');
    clock = reviewed.valid_until;
    // Not while nonce 4 is unused: the transaction can still be mined.
    await expect(
      service.release(RULE_A, 'profile-1', 'op-1', unmined(null, 4))
    ).rejects.toThrow('nonce 4 is not used yet');
    // Never when Ethereum has a receipt for the hash.
    await expect(
      service.release(RULE_A, 'profile-1', 'op-1', unmined(delivered(1), 5))
    ).rejects.toThrow('was mined');
    // Never with another hash than the one sent.
    await expect(
      service.release(RULE_A, 'profile-1', 'op-1', unmined(null, 5, SENT_3))
    ).rejects.toThrow('reconcile it instead');
    // The wallet mined past nonce 4 and the hash has no receipt: released.
    const released = await service.release(
      RULE_A,
      'profile-1',
      'op-1',
      unmined(null, 5)
    );
    expect(released.pending_review).toBeNull();
    expect(logged[logged.length - 1]).toEqual({
      kind: 'released',
      rule: RULE_A,
      operation_id: 'op-1',
      transaction_hash: SENT_1,
      at: clock
    });
    const live = await answers();

    // The rebuild applies the same rule on Ethereum as it is then.
    chain[SENT_1] = { transaction: null, receipt: null };
    mined = 5;
    usedNonce = cancel();
    await emptyTables();
    expect((await replay(logged)).refused).toEqual([]);
    expect(await answers()).toEqual(live);
    mined = 4;
    await emptyTables();
    expect((await replay(logged)).refused).toEqual([
      {
        what: `collect released ${RULE_A}`,
        detail:
          "The sent purchase can't be released: nonce 4 is not used yet, so the transaction can still be mined."
      }
    ]);
    chain[SENT_1] = { transaction: purchase(100), receipt: delivered(1) };
    mined = 5;
    await emptyTables();
    expect((await replay(logged)).refused).toEqual([
      {
        what: `collect released ${RULE_A}`,
        detail:
          "The sent purchase can't be released: the sent transaction was mined."
      }
    ]);
    const [rule] = await service.list('profile-1', 10);
    expect(rule.pending_review?.operation_id).toBe('op-1');
  });

  it('settles a purchase sped up under another hash, never releases it', async () => {
    await record(RULE_A, false, 1, '0xn1');
    at(2);
    const reviewed = review('op-1', clock);
    await service.reserveReview(RULE_A, 'profile-1', reviewed);
    at(3);
    await sent('op-1', SENT_1);
    // The wallet sped it up: the same purchase mined as SENT_3 at nonce 4.
    const spedUp: NonceTransaction = {
      hash: SENT_3,
      transaction: purchase(100),
      receipt: delivered(1)
    };
    clock = reviewed.valid_until + 60_000;
    await expect(
      service.release(RULE_A, 'profile-1', 'op-1', {
        transactionHash: SENT_1,
        evidence: {
          transaction: null,
          receipt: null,
          minedNonce: async () => 5,
          nonceTransaction: async () => spedUp
        }
      })
    ).rejects.toThrow(`is the purchase, mined as ${SENT_3}`);
    // Settled from the transaction that used the nonce.
    await service.settle(
      RULE_A,
      'profile-1',
      confirmed('op-1', SENT_3),
      spedUp
    );
    const live = await answers();
    expect(live.rules[0].pending_review).toBeNull();
    expect(live.rules[0].spent_item_cost_wei).toBe('100');
    expect(logged[logged.length - 1]).toMatchObject({
      kind: 'settle',
      settlement: { transaction_hash: SENT_3 }
    });
    // Replayed from Ethereum: SENT_3 at the logged nonce.
    chain[SENT_3] = { transaction: purchase(100), receipt: delivered(1) };
    await emptyTables();
    expect((await replay(logged)).refused).toEqual([]);
    expect(await answers()).toEqual(live);
    // Not if that transaction is at another nonce.
    chain[SENT_3] = {
      transaction: { ...purchase(100), nonce: 9 },
      receipt: delivered(1)
    };
    await emptyTables();
    expect((await replay(logged)).refused).toEqual([
      {
        what: `collect settle ${RULE_A}`,
        detail:
          'the settlement is not of the sent transaction, nor of one at its nonce'
      }
    ]);
    // A release of it is refused on rebuild too.
    const released = logged.filter((body) => body.kind !== 'settle');
    released.push({
      kind: 'released',
      rule: RULE_A,
      operation_id: 'op-1',
      transaction_hash: SENT_1,
      at: clock
    });
    chain[SENT_1] = { transaction: null, receipt: null };
    mined = 5;
    usedNonce = spedUp;
    await emptyTables();
    expect((await replay(released)).refused).toEqual([
      {
        what: `collect released ${RULE_A}`,
        detail: `The transaction at nonce 4 is the purchase, mined as ${SENT_3}: settle it instead.`
      }
    ]);
  });

  it('never releases a hash kept before nonces were', async () => {
    // Outside primary and the freeze, the hash is kept as the market
    // accepted it, unchecked and with no nonce: as a row sent before.
    primary = false;
    await record(RULE_A, false, 1, '0xm1');
    at(2);
    const reviewed = review('op-1', clock);
    await service.reserveReview(RULE_A, 'profile-1', reviewed);
    at(3);
    await sent('op-1', SENT_1);
    expect((await service.findOperation('op-1'))?.transaction_nonce).toBeNull();
    clock = reviewed.valid_until + 86_400_000;
    await expect(
      service.release(RULE_A, 'profile-1', 'op-1', {
        transactionHash: SENT_1,
        evidence: {
          transaction: null,
          receipt: null,
          minedNonce: async () => 100,
          nonceTransaction: async () => cancel()
        }
      })
    ).rejects.toThrow('nonce is not known');
  });

  it('logs a sent hash while settings are frozen, before primary', async () => {
    primary = false;
    await record(RULE_A, false, 1, '0xk1');
    at(2);
    await service.reserveReview(RULE_A, 'profile-1', review('op-1', clock));
    at(3);
    await sent('op-1', SENT_1);
    expect(logged).toEqual([]);
    frozen = true;
    at(4);
    await sqlExecutor.execute(
      `update ${COLLECT_RULE_OPERATIONS_TABLE} set transaction_hash = null`
    );
    await sent('op-1', SENT_2);
    expect(logged).toEqual([
      {
        kind: 'sent',
        rule: RULE_A,
        operation_id: 'op-1',
        transaction_hash: SENT_2,
        nonce: 4,
        at: START + 4_000
      }
    ]);
    // Replayed whatever its time: after an import that read the binding
    // without the hash, the rebuild still has it.
    await sqlExecutor.execute(
      `update ${COLLECT_RULE_OPERATIONS_TABLE} set transaction_hash = null`
    );
    expect(await replay(logged, importOrderKey(2000, START + 10_000))).toEqual({
      applied: 1,
      refused: []
    });
    expect((await service.findOperation('op-1'))?.transaction_hash).toBe(
      SENT_2
    );
  });

  it("refuses what live would have refused: live's checks on replay", async () => {
    await record(RULE_A, false, 1, '0xl1');
    await record(RULE_B, false, 2, '0xl2');
    at(3);
    await service.reserveReview(RULE_A, 'profile-1', review('op-1', clock));
    const entries: CollectLogBody[] = [
      // A sent hash for an operation no rule has.
      {
        kind: 'sent',
        rule: RULE_A,
        operation_id: 'op-x',
        transaction_hash: SENT_1,
        nonce: 4,
        at: START + 4_000
      },
      // A release of what isn't pending.
      {
        kind: 'released',
        rule: RULE_B,
        operation_id: 'op-1',
        transaction_hash: null,
        at: START + 100_000
      },
      // A release before the quote expired.
      {
        kind: 'released',
        rule: RULE_A,
        operation_id: 'op-1',
        transaction_hash: null,
        at: START + 4_000
      },
      // A settlement of another rule's operation.
      {
        kind: 'settle',
        rule: RULE_B,
        settlement: confirmed('op-1'),
        settlement_hash: 'f'.repeat(64),
        at: START + 5_000
      }
    ];
    chain[SENT_1] = { transaction: purchase(100), receipt: delivered(1) };
    const result = await replay(entries);
    expect(result.applied).toBe(0);
    expect(result.refused.map((it) => it.detail)).toEqual([
      'Operation is not bound to this rule.',
      'No pending purchase to release.',
      'The pending purchase can still be sent.',
      'Settlement does not match the pending operation.'
    ]);
  });
});
