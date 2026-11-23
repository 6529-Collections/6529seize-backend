import 'reflect-metadata';
import { getAddress } from 'ethers';
import { collectingAssetKey } from '@/collecting/collecting-analysis';
import type { CollectRulesJournal } from '@/collecting/collecting-rules.journal';
import type { CollectLogBody } from '@/collecting/collecting-rules.log';
import {
  COLLECT_RULES_TABLE,
  CollectingRulesService
} from '@/collecting/collecting-rules.service';
import type { CollectingRuleDefinition } from '@/collecting/collecting-rules.types';
import { MEMES_CONTRACT } from '@/constants';
import {
  signRecordEvent,
  SignedRecordEvent
} from '@/signed-records/record-event';
import { RecordRegistry } from '@/signed-records/record-index';
import { RecordKind } from '@/signed-records/record-kinds';
import {
  grantSource,
  hexBytes,
  VECTOR_GRANT,
  vectorDeviceKey,
  VECTORS
} from '@/signed-records/record-test-fixtures';
import { SealedClass, sealItems } from '@/signed-records/sealed-crypto';
import { SignedRecordHeadsDb } from '@/signed-records/signed-record-heads.db';
import { dbSupplier, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import type { CollectRuleDeps } from './collect-rule-records';
import { registerPersonalRecordTypes } from './personal-record-types';
import type { PersonalLiveEffects } from './personal-records.ports';
import { PersonalRecordsService } from './personal-records.service';
import { FixtureOwnerDirectory } from './personal-records.test-fixtures';
import { personalTables } from './personal-records.wiring';

const inputs = VECTORS.inputs;
const P_ME = inputs.principal;
const PROFILE = 'collect-records-me';
const T = VECTORS.followRecord.claimed_time;
const ANCHOR = 1001;
// The page's Idempotency-Key for a new rule, and the id of a rule keyed by it.
const KEY = 'd9ae3ffc-6cff-4a29-b997-7908c632c121';
const provider = {
  id: inputs.providerKeyId,
  privateKey: hexBytes(inputs.providerPrivateKey),
  publicKey: hexBytes(inputs.providerPublicKey)
};

/**
 * The terms as the page signs them: the funding wallet as the wallet
 * reports it (EIP-55 mixed case), the targets in the plan's order. The
 * rules store keeps them lowercased and in asset order.
 */
const pageTerms = (): CollectingRuleDefinition => {
  const wallet = getAddress('0x000000000000000000000000000000000000abcd');
  return {
    profile_id: PROFILE,
    funding_wallet: wallet,
    recipient: wallet,
    plan_id: null,
    analysis_id: null,
    targets: [
      {
        asset_key: collectingAssetKey(MEMES_CONTRACT, '2'),
        target_quantity: '1',
        maximum_unit_price_wei: '100'
      },
      {
        asset_key: collectingAssetKey(MEMES_CONTRACT, '1'),
        target_quantity: '1',
        maximum_unit_price_wei: '100'
      }
    ],
    max_total_cost_wei: '1000000',
    max_gas_reserve_wei: '100000',
    expires_at: T + 30 * 86_400_000,
    max_actions: 2
  };
};

let seq = 1_960_000_000_000;
/** A sealed record holding one `collect.rule` item, signed by the vectors' device. */
function ruleRecord(ruleId: string, paused: boolean): SignedRecordEvent {
  seq += 1;
  const wave = `pv/${P_ME}`;
  const sealed = sealItems({
    wave,
    cls: SealedClass.PROVIDER,
    gen: 1,
    deviceKey: inputs.deviceKey,
    senderKey: hexBytes(inputs.senderKey),
    items: [
      {
        t: 'collect.rule',
        k: ruleId,
        b: { definition: pageTerms(), paused }
      }
    ] as never
  });
  return signRecordEvent(
    {
      kind: RecordKind.SEALED,
      wave,
      refs: ['settings'],
      body: { c: sealed.toString('base64url'), v: 1 },
      author: inputs.author,
      deviceKey: inputs.deviceKey,
      authRef: inputs.authRef,
      seq,
      anchor: ANCHOR,
      claimedTime: T + (seq % 1000) + 1
    },
    vectorDeviceKey()
  );
}

const NO_LIVE_EFFECTS = new Proxy(
  {},
  { get: () => async () => undefined }
) as PersonalLiveEffects;

describeWithSeed('collect.rule records against rules saved today', [], () => {
  const logged: CollectLogBody[] = [];
  const journal: CollectRulesJournal = {
    enabled: () => true,
    frozen: async () => false,
    append: async (body) => {
      logged.push(body);
    }
  };
  const rules = new CollectingRulesService(dbSupplier, () => T, journal);
  const owners = new FixtureOwnerDirectory(new Map([[P_ME, PROFILE]]), [
    { wallet: inputs.author, principal: P_ME, from: 1 }
  ]);
  const collect: CollectRuleDeps = {
    applyRule: (change, _mode, ctx) =>
      rules.applyRuleRecord(change, ctx.connection!),
    restoreRule: (state, ctx) => rules.restoreRule(state, ctx.connection!),
    restoreOperation: (binding, ctx) =>
      rules.restoreOperation(binding, ctx.connection!)
  };
  const service = () =>
    new PersonalRecordsService({
      grants: grantSource([VECTOR_GRANT]),
      owners,
      anchors: {
        getAnchor: async () => ({
          anchor: ANCHOR + 50,
          headHeight: ANCHOR + 52,
          finalizedTime: T,
          maxAnchorLag: 120
        })
      },
      heads: new SignedRecordHeadsDb(() => sqlExecutor),
      registry: registerPersonalRecordTypes(new RecordRegistry(), {
        owners,
        tables: personalTables,
        live: NO_LIVE_EFFECTS,
        collect
      }),
      providers: () => [provider],
      log: { appendEvents: async () => undefined },
      importOrder: async () => null,
      now: () => T,
      maxClockSkewMs: 10 * 60 * 1000
    });
  const savedRules = () =>
    sqlExecutor.execute<{ id: string; idempotency_key: string; state: string }>(
      `select id, idempotency_key, state from ${COLLECT_RULES_TABLE} order by id`
    );

  beforeEach(() => {
    logged.length = 0;
  });

  it("checks a create's shadow companion against the rule today's route saved", async () => {
    // Today's route saves the rule under its own id, with the page's key.
    const saved = await rules.create(pageTerms(), KEY);
    expect(saved.id).not.toBe(KEY);
    const before = await savedRules();

    // Shadow: the companion, keyed by that key, is checked and rolled back.
    const shadow = await service().submit(
      [VECTORS.keys.event, ruleRecord(KEY, false)],
      'shadow',
      PROFILE,
      {}
    );
    expect(shadow.map((result) => result.outcome)).toEqual([
      'logged',
      'applied'
    ]);
    expect(await savedRules()).toEqual(before);

    // Primary: the same create sent again lands on that rule, unchanged.
    const again = await service().submit(
      [VECTORS.keys.event, ruleRecord(KEY, false)],
      'primary',
      PROFILE,
      {}
    );
    expect(again.map((result) => result.outcome)).toEqual(['stale', 'applied']);
    expect(await savedRules()).toEqual(before);
    // It repeats the rule's state, so nothing is logged either.
    expect(logged).toEqual([]);

    // And a pause keyed by that key pauses it, logged under the key.
    await service().submit(
      [VECTORS.keys.event, ruleRecord(KEY, true)],
      'primary',
      PROFILE,
      {}
    );
    expect(await savedRules()).toEqual([
      { id: saved.id, idempotency_key: KEY, state: 'PAUSED' }
    ]);
    expect(logged).toEqual([
      expect.objectContaining({ kind: 'rule', rule: KEY, paused: true })
    ]);
  });

  it('takes the same create twice with a checksummed wallet and targets in plan order', async () => {
    const create = () =>
      sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        rules.applyRuleRecord(
          {
            id: KEY,
            profileId: PROFILE,
            definition: pageTerms(),
            paused: false,
            eventId: `0x${'e'.repeat(64)}`
          },
          connection
        )
      );
    await create();
    const [stored] = await rules.list(PROFILE, 10);
    // Saved in the store's one form.
    expect(stored.definition.funding_wallet).toBe(
      '0x000000000000000000000000000000000000abcd'
    );
    expect(stored.definition.targets.map((target) => target.asset_key)).toEqual(
      [
        collectingAssetKey(MEMES_CONTRACT, '1'),
        collectingAssetKey(MEMES_CONTRACT, '2')
      ]
    );
    // Sent again (a retry after a timeout): the same terms, nothing changes.
    await create();
    expect(await rules.list(PROFILE, 10)).toEqual([stored]);
    expect(logged.map((body) => body.kind)).toEqual(['rule']);
  });
});
