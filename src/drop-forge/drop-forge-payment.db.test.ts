import {
  DROP_METADATA_TABLE,
  MINTING_CLAIMS_TABLE,
  NULL_ADDRESS,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_ID_STATE_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { artistPaymentQuote } from '@/drop-forge/drop-forge.payment';
import { buildLaunchPlan } from '@/drop-forge/drop-forge.plan';
import {
  testConfig,
  testPlan,
  testSource
} from '@/drop-forge/drop-forge.test-fixtures';
import { sqlExecutor } from '@/sql-executor';
import {
  OPENING_STATE_ID,
  SHADOW_ENV,
  subscriptionsIdentitySwitch
} from '@/subscriptions-identity/identity/identity-switch';
import { describeWithSeed } from '@/tests/_setup/seed';

const CONTRACT = testConfig.creator.toLowerCase();
const CLAIM = 1;
const BLOCK = 100;
const PAYEE = '0x' + '66'.repeat(20);
const KEPT = '0x' + '55'.repeat(20);
// A subscriber the legacy tables can't hold (say a wide identity): after
// the switch its airdrop is charged in the identity table only.
const NOT_KEPT = '0x' + '57'.repeat(20);
const BUYER = '0x' + '58'.repeat(20);
const AIRDROP_TO_KEPT = '0x' + 'a1'.repeat(32);
const AIRDROP_TO_NOT_KEPT = '0x' + 'a2'.repeat(32);
const AT = new Date('2026-12-02T14:00:00Z');

function launch() {
  const data = buildLaunchPlan(
    testConfig,
    CLAIM,
    testPlan,
    {
      ...testSource,
      rows: [KEPT, NOT_KEPT].map((wallet) => ({
        phase: 'Phase 0',
        wallet,
        count: 1,
        count_airdrop: 1,
        count_allowlist: 0
      }))
    },
    0
  );
  for (const action of data.actions)
    if (action.kind === 'AIRDROP') action.state = 'CONFIRMED';
  return data;
}

function transaction(
  hash: string,
  to: string,
  count: number,
  value: number
): Record<string, unknown> {
  return {
    created_at: AT,
    transaction: hash,
    block: BLOCK - 10,
    transaction_date: AT,
    from_address: NULL_ADDRESS,
    to_address: to,
    contract: CONTRACT,
    token_id: CLAIM,
    token_count: count,
    value,
    primary_proceeds: value,
    royalties: 0,
    gas_gwei: 0,
    gas_price: 0,
    gas_price_gwei: 0,
    gas: 0
  };
}

function redeemed(hash: string, address: string) {
  return {
    consolidation_key: address,
    contract: CONTRACT,
    token_id: CLAIM,
    address,
    transaction: hash,
    transaction_date: AT,
    value: 0.06529,
    balance_after: 1,
    count: 1
  };
}

async function insert(table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  await sqlExecutor.execute(
    `INSERT INTO ${table} (${columns.map((c) => `\`${c}\``).join(', ')})
      VALUES (${columns.map((c) => `:${c}`).join(', ')})`,
    row
  );
}

/** Charged in the legacy table: the legacy loop's rows, before the switch. */
async function chargeLegacy(hash: string, address: string) {
  await insert(SUBSCRIPTIONS_REDEEMED_TABLE, redeemed(hash, address));
}

/**
 * Charged in the identity table: go-live's copy of a legacy row, or the
 * identity writer's row after the switch.
 */
async function chargeIdentity(hash: string, address: string) {
  await insert(SUBSCRIPTIONS_ID_REDEEMED_TABLE, {
    ...redeemed(hash, address),
    identity_key: address
  });
}

async function setSwitch(mode: 'OFF' | 'SHADOW' | 'TRUTH' | 'SUSPENDED') {
  await sqlExecutor.execute(`DELETE FROM ${SUBSCRIPTIONS_ID_STATE_TABLE}`);
  if (mode === 'OFF') {
    delete process.env[SHADOW_ENV];
  } else {
    process.env[SHADOW_ENV] = 'true';
    const now = Date.now();
    await insert(SUBSCRIPTIONS_ID_STATE_TABLE, {
      id: OPENING_STATE_ID,
      opening_sha256: 'a'.repeat(64),
      history_sha256: 'b'.repeat(64),
      cut_at: now - 60_000,
      loaded_at: now - 50_000,
      verified_at: now - 40_000,
      suspended_at: mode === 'SUSPENDED' ? now - 1_000 : null,
      switch_at: mode === 'SHADOW' ? null : now - 30_000
    });
  }
  subscriptionsIdentitySwitch.invalidate();
}

const shadowFlag = process.env[SHADOW_ENV];
afterAll(() => {
  if (shadowFlag === undefined) {
    delete process.env[SHADOW_ENV];
  } else {
    process.env[SHADOW_ENV] = shadowFlag;
  }
  subscriptionsIdentitySwitch.invalidate();
});

describeWithSeed(
  'the artist payment counts the redemptions the subscriptions switch names',
  [
    {
      table: TRANSACTIONS_TABLE,
      rows: [
        transaction(AIRDROP_TO_KEPT, KEPT, 1, 0),
        transaction(AIRDROP_TO_NOT_KEPT, NOT_KEPT, 1, 0),
        transaction('0x' + 'b1'.repeat(32), BUYER, 3, 300)
      ]
    },
    {
      table: MINTING_CLAIMS_TABLE,
      rows: [
        {
          drop_id: 'drop-1',
          contract: CONTRACT,
          claim_id: CLAIM,
          description: 'card',
          name: 'card',
          attributes: []
        }
      ]
    },
    {
      table: DROP_METADATA_TABLE,
      rows: [
        {
          drop_id: 'drop-1',
          data_key: 'payment_info',
          data_value: JSON.stringify({
            payment_address: PAYEE,
            has_designated_payee: true
          })
        }
      ]
    }
  ],
  () => {
    // Three paid mints and two subscription airdrops: half of five mints.
    const paysBoth = {
      paid_count: 3,
      subscriptions_count: 2,
      amount_wei: '250'
    };

    it('after the switch, pays for a subscriber the legacy copy lacks', async () => {
      await chargeLegacy(AIRDROP_TO_KEPT, KEPT);
      await chargeIdentity(AIRDROP_TO_KEPT, KEPT);
      await chargeIdentity(AIRDROP_TO_NOT_KEPT, NOT_KEPT);

      await setSwitch('TRUTH');
      expect(await artistPaymentQuote(launch(), 5, BLOCK)).toMatchObject(
        paysBoth
      );

      // The legacy table is short by that airdrop: before the switch, and
      // after a rollback, the payment waits instead of paying.
      for (const mode of ['OFF', 'SHADOW', 'SUSPENDED'] as const) {
        await setSwitch(mode);
        await expect(artistPaymentQuote(launch(), 5, BLOCK)).rejects.toThrow(
          'Artist payment accounting is incomplete or inconsistent with the launch'
        );
      }
    });

    it('pays the same for a card charged before the switch, either side of it', async () => {
      for (const [hash, address] of [
        [AIRDROP_TO_KEPT, KEPT],
        [AIRDROP_TO_NOT_KEPT, NOT_KEPT]
      ]) {
        await chargeLegacy(hash, address);
        await chargeIdentity(hash, address);
      }

      await setSwitch('SHADOW');
      const before = await artistPaymentQuote(launch(), 5, BLOCK);
      await setSwitch('TRUTH');
      const after = await artistPaymentQuote(launch(), 5, BLOCK);

      expect(before).toMatchObject(paysBoth);
      expect(after).toEqual(before);
    });
  }
);
