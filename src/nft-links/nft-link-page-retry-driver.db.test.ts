import { connect, disconnect } from '@/db';
import { NFT_LINKS_TABLE } from '@/constants';
import { setSqlExecutor, sqlExecutor, SqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { Time } from '@/time';
import { NftLinksDb } from './nft-links.db';
import { validateLinkUrl } from './nft-link-resolver.validator';
import {
  isNftLinkRefreshDue,
  nextNftPageRetryState,
  nftPageRetryScope,
  readNftPageRetryState
} from './nft-link-page-retry';

const canonical = validateLinkUrl('https://transient.xyz/mint/driver-fixture');
const scope = nftPageRetryScope(canonical);
const args = {
  canonical,
  lockTTL: Time.minutes(2),
  updateMinInterval: Time.minutes(2)
};

describeWithSeed(
  'NFT retry eligibility with the actual worker TypeORM driver',
  {
    table: NFT_LINKS_TABLE,
    rows: [
      {
        canonical_id: canonical.canonicalId,
        platform: canonical.platform,
        last_tried_to_update: 0,
        last_successfully_updated: 1
      }
    ]
  },
  () => {
    describe('worker connection', () => {
      let original: SqlExecutor;
      const db = new NftLinksDb(() => sqlExecutor);
      beforeEach(async () => {
        original = sqlExecutor;
        await connect();
      });
      afterEach(async () => {
        try {
          await disconnect();
        } finally {
          setSqlExecutor(original);
        }
      });

      it.each([0, 1_700_000_000_000])(
        'acquires eligible work after timestamp %s',
        async (attemptedAt) => {
          await sqlExecutor.execute(
            `UPDATE ${NFT_LINKS_TABLE} SET last_tried_to_update=:attemptedAt`,
            { attemptedAt }
          );
          const row = (await db.findByCanonicalId(canonical.canonicalId, {}))!;
          expect(typeof row.last_tried_to_update).toBe('string');
          expect(isNftLinkRefreshDue(row, canonical, Date.now(), 120_000)).toBe(
            true
          );
          const owned = await db.lockForProcessing(args, {});
          expect(owned).not.toBeNull();
          expect(typeof owned!.is_locked_since).toBe('number');
          expect(await db.lockForProcessing(args, {})).toBeNull();
        }
      );

      it('preserves persisted 404 eligibility and streak across string timestamp reads', async () => {
        let row = (await db.findByCanonicalId(canonical.canonicalId, {}))!;
        let attemptedAt = Date.now() - Time.hours(3).toMillis();
        for (const [streak, minutes] of [
          [1, 5],
          [2, 15],
          [3, 60]
        ]) {
          const retry = nextNftPageRetryState(row, scope, attemptedAt, 1);
          expect(retry.streak).toBe(streak);
          expect(retry.notBefore - attemptedAt).toBe(minutes * 60_000);
          const owned = (await db.lockForProcessing(args, {}))!;
          expect(owned).not.toBeNull();
          await db.updateWithFailure(
            {
              canonicalId: canonical.canonicalId,
              message: 'Required NFT canonical page returned HTTP 404',
              lockStamp: owned.is_locked_since!,
              attemptedAt,
              retryState: retry
            },
            {}
          );
          row = (await db.findByCanonicalId(canonical.canonicalId, {}))!;
          expect(typeof row.last_tried_to_update).toBe('string');
          expect(typeof row.failed_since).toBe('string');
          expect(typeof row.last_successfully_updated).toBe('string');
          expect(readNftPageRetryState(row, scope)).toEqual(retry);
          expect(
            isNftLinkRefreshDue(row, canonical, retry.notBefore - 1, 120_000)
          ).toBe(false);
          expect(
            isNftLinkRefreshDue(row, canonical, retry.notBefore, 120_000)
          ).toBe(true);
          attemptedAt = retry.notBefore + 1;
        }
      });
    });
  }
);
