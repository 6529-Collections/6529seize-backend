import { randomBytes, randomUUID } from 'node:crypto';
import { MarketOperationsDb } from '@/marketplace/market-operations.db';
import { dbSupplier } from '@/sql-executor';
import {
  MARKET_WETH,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';
import { CollectingRulesService } from '@/collecting/collecting-rules.service';
import type { CollectingRuleReview } from '@/collecting/collecting-rules.types';

const address = () => `0x${randomBytes(20).toString('hex')}`;
const db = new MarketOperationsDb(dbSupplier);
async function create(
  wallet: string,
  profileId: string,
  key = randomUUID(),
  amount = '60'
) {
  return db.create({
    wallet,
    profileId,
    key,
    currency: MARKET_WETH,
    request: { kind: 'OFFER', amount_wei: amount }
  });
}

describe('market DB serialization and durable claims', () => {
  it('recovers only the signing wallet historical operations across profile changes', async () => {
    const oldProfile = randomUUID(),
      newProfile = randomUUID();
    const migratingWallet = address(),
      oldSibling = address(),
      newSibling = address();
    const own = await create(migratingWallet, oldProfile);
    const privateSibling = await create(oldSibling, oldProfile);
    const currentSibling = await create(newSibling, newProfile);

    expect(
      (
        await db.getForActor(
          own.operation.id,
          newProfile,
          migratingWallet.toUpperCase()
        )
      ).id
    ).toBe(own.operation.id);
    expect(
      (
        await db.getForActor(
          currentSibling.operation.id,
          newProfile,
          migratingWallet
        )
      ).id
    ).toBe(currentSibling.operation.id);
    await expect(
      db.getForActor(privateSibling.operation.id, newProfile, migratingWallet)
    ).rejects.toThrow();
    await expect(
      db.getForActor(own.operation.id, randomUUID(), oldSibling)
    ).rejects.toThrow();
    await expect(db.get(own.operation.id, newProfile)).rejects.toThrow();

    const page = await db.page(newProfile, 20, undefined, migratingWallet);
    expect(
      page.map((row) => row.id).sort((a, b) => a.localeCompare(b))
    ).toEqual(
      [own.operation.id, currentSibling.operation.id].sort((a, b) =>
        a.localeCompare(b)
      )
    );
    expect(page.some((row) => row.id === privateSibling.operation.id)).toBe(
      false
    );
  });
  it('creates one operation for concurrent identical idempotent requests and rejects changed terms', async () => {
    const wallet = address(),
      profile = randomUUID(),
      key = randomUUID();
    const [a, b] = await Promise.all([
      create(wallet, profile, key),
      create(wallet, profile, key)
    ]);
    expect(a.operation.id).toBe(b.operation.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    await expect(create(wallet, profile, key, '61')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT'
    });
    await expect(create(wallet, randomUUID(), key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT'
    });
    const events = await dbSupplier().execute<{ state: string }>(
      'SELECT state FROM market_operation_events WHERE operation_id=:id',
      { id: a.operation.id }
    );
    expect(events).toEqual([{ state: 'PREPARING' }]);
  });
  it('serializes concurrent offer reservations and never exposes more than the funding balance', async () => {
    const wallet = address(),
      profile = randomUUID();
    const [a, b] = await Promise.all([
      create(wallet, profile),
      create(wallet, profile)
    ]);
    const results = await Promise.allSettled(
      [a, b].map((item) =>
        db.transition(item.operation.id, ['PREPARING'], 'REVIEW', {
          liabilityWei: '60',
          fundingBalanceWei: '100',
          prepared: { review: 'signable' }
        })
      )
    );
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1
    );
    const failed = results.find(
      (item) => item.status === 'rejected'
    ) as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'OFFER_EXPOSURE_EXCEEDED' });
    const rows = await db.list(profile);
    expect(
      rows.reduce((sum, row) => sum + BigInt(row.liability_wei), BigInt(0))
    ).toBe(BigInt(60));
    expect(rows.filter((row) => row.state === 'REVIEW')).toHaveLength(1);
    const rejectedRow = rows.find((row) => row.state === 'PREPARING')!;
    expect(rejectedRow.prepared_json).toBeNull();
  });
  it('sums exposure with integers beyond SQL decimal and JavaScript safe-number precision', async () => {
    const wallet = address(),
      profile = randomUUID();
    const first = await create(wallet, profile),
      second = await create(wallet, profile);
    const liability =
      '6000000000000000000000000000000000000000000000000000000000000000000000000000';
    const balance =
      '10000000000000000000000000000000000000000000000000000000000000000000000000000';
    await db.transition(first.operation.id, ['PREPARING'], 'REVIEW', {
      liabilityWei: liability,
      fundingBalanceWei: balance
    });
    await expect(
      db.transition(second.operation.id, ['PREPARING'], 'REVIEW', {
        liabilityWei: liability,
        fundingBalanceWei: balance
      })
    ).rejects.toMatchObject({ code: 'OFFER_EXPOSURE_EXCEEDED' });
    expect((await db.get(first.operation.id, profile)).liability_wei).toBe(
      liability
    );
  });
  it('retains potential exposure through expired quote TTL and unknown publication', async () => {
    const wallet = address(),
      profile = randomUUID();
    const first = await create(wallet, profile),
      second = await create(wallet, profile);
    await db.transition(first.operation.id, ['PREPARING'], 'REVIEW', {
      liabilityWei: '80',
      fundingBalanceWei: '100'
    });
    await db.transition(first.operation.id, ['REVIEW'], 'UNKNOWN', {
      expiresAt: 1
    });
    expect((await db.get(first.operation.id, profile)).liability_wei).toBe(
      '80'
    );
    await expect(
      db.transition(second.operation.id, ['PREPARING'], 'REVIEW', {
        liabilityWei: '30',
        fundingBalanceWei: '100'
      })
    ).rejects.toMatchObject({ code: 'OFFER_EXPOSURE_EXCEEDED' });
    await db.transition(first.operation.id, ['UNKNOWN'], 'CANCELLED', {
      liabilityWei: '0'
    });
    await db.transition(second.operation.id, ['PREPARING'], 'REVIEW', {
      liabilityWei: '30',
      fundingBalanceWei: '100'
    });
    expect((await db.get(second.operation.id, profile)).liability_wei).toBe(
      '30'
    );
  });
  it('atomically binds a transaction hash to one operation across different wallet locks', async () => {
    const profile = randomUUID(),
      hash = `0x${randomBytes(32).toString('hex')}`;
    const [a, b] = await Promise.all([
      create(address(), profile),
      create(address(), profile)
    ]);
    await Promise.all(
      [a, b].map((item) =>
        db.transition(item.operation.id, ['PREPARING'], 'REVIEW')
      )
    );
    const results = await Promise.allSettled([
      db.transition(a.operation.id, ['REVIEW'], 'SUBMITTED', {
        transactionHash: hash
      }),
      db.transition(b.operation.id, ['REVIEW'], 'SUBMITTED', {
        transactionHash: `0x${hash.slice(2).toUpperCase()}`
      })
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1
    );
    const failed = results.find(
      (item) => item.status === 'rejected'
    ) as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({
      code: 'TRANSACTION_ALREADY_CLAIMED'
    });
    const rows = await db.list(profile);
    const accepted = rows.find((row) => row.transaction_hash === hash)!;
    expect(rows.filter((row) => row.transaction_hash === hash)).toHaveLength(1);
    await db.transition(accepted.id, ['SUBMITTED'], 'SUBMITTED', {
      transactionHash: hash
    });
    expect((await db.get(accepted.id, profile)).transaction_hash).toBe(hash);
  });
  it('keeps immutable transaction history scoped to its operation and rolls it back with failed transitions', async () => {
    const profile = randomUUID(),
      wallet = address();
    const first = await create(wallet, profile),
      second = await create(wallet, profile);
    const digest = randomBytes(32).toString('hex'),
      nextDigest = randomBytes(32).toString('hex');
    const prepared = { transaction: 'first', snapshot: { block_number: 100 } };
    await db.transition(first.operation.id, ['PREPARING'], 'REVIEW', {
      prepared,
      reviewedTransaction: { digest, prepared }
    });
    await db.transition(first.operation.id, ['REVIEW'], 'REVIEW', {
      prepared: { transaction: 'refresh' },
      reviewedTransaction: {
        digest,
        prepared: { transaction: 'cannot-overwrite' }
      }
    });
    const saved = await db.reviewedTransaction(first.operation.id, digest);
    expect(typeof saved === 'string' ? JSON.parse(saved) : saved).toEqual(
      prepared
    );
    expect(
      await db.reviewedTransaction(second.operation.id, digest)
    ).toBeUndefined();
    await expect(
      db.transition(first.operation.id, ['PREPARING'], 'REVIEW', {
        reviewedTransaction: { digest: nextDigest, prepared }
      })
    ).rejects.toMatchObject({ code: 'OPERATION_CHANGED' });
    expect(
      await db.reviewedTransaction(first.operation.id, nextDigest)
    ).toBeUndefined();
  });
  it('commits rule reservations and market review payloads together, exposing neither when the rule budget fails', async () => {
    const profile = randomUUID(),
      wallet = address(),
      now = Date.now();
    const rules = new CollectingRulesService(dbSupplier, () => now);
    const assetKey = '1:0x33fd426905f149f8376e227d0c9d3340aad17af1:56';
    for (const budget of ['50', '100']) {
      const rule = await rules.create(
        {
          profile_id: profile,
          funding_wallet: wallet,
          recipient: wallet,
          plan_id: null,
          analysis_id: null,
          targets: [
            {
              asset_key: assetKey,
              target_quantity: '1',
              maximum_unit_price_wei: '60'
            }
          ],
          max_total_cost_wei: budget,
          max_gas_reserve_wei: '10',
          expires_at: now + 86400000,
          max_actions: 1
        },
        randomUUID()
      );
      const key = randomUUID();
      const operation = await db.create({
        wallet,
        profileId: profile,
        key,
        currency: MARKET_ZERO_ADDRESS,
        request: { kind: 'BUY' },
        ruleId: rule.id
      });
      const review: CollectingRuleReview = {
        operation_id: operation.operation.id,
        quote_id: 'quote',
        profile_id: profile,
        funding_wallet: wallet,
        recipient: wallet,
        valid_until: now + 20000,
        assets: [{ asset_key: assetKey, quantity: '1', unit_price_wei: '60' }],
        item_cost_wei: '60',
        gas_reserve_wei: '10'
      };
      const digest = randomBytes(32).toString('hex');
      const prepared = { reviewed: budget };
      const transition = db.transition(
        operation.operation.id,
        ['PREPARING'],
        'REVIEW',
        {
          prepared,
          reviewedTransaction: { digest, prepared },
          beforeCommit: async (connection) => {
            await rules.reserveReview(rule.id, profile, review, connection);
          }
        }
      );
      if (budget === '50') {
        await expect(transition).rejects.toThrow(/budget/);
        expect(
          (await db.get(operation.operation.id, profile)).prepared_json
        ).toBeNull();
        expect(
          await db.reviewedTransaction(operation.operation.id, digest)
        ).toBeUndefined();
        expect((await rules.get(rule.id, profile)).pending_review).toBeNull();
        expect(
          await dbSupplier().execute(
            'SELECT operation_id FROM collect_rule_operations WHERE operation_id=:id',
            { id: operation.operation.id }
          )
        ).toEqual([]);
      } else {
        await transition;
        expect((await db.get(operation.operation.id, profile)).state).toBe(
          'REVIEW'
        );
        expect(
          await db.reviewedTransaction(operation.operation.id, digest)
        ).toBeDefined();
        expect(
          (await rules.get(rule.id, profile)).pending_review?.operation_id
        ).toBe(operation.operation.id);
        await expect(
          db.create({
            wallet,
            profileId: profile,
            key,
            currency: MARKET_ZERO_ADDRESS,
            request: { kind: 'BUY' }
          })
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      }
    }
  });
});
