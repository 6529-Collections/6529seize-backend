import { describeWithSeed } from '@/tests/_setup/seed';
import { sqlExecutor } from '@/sql-executor';
import { NFT_LINKS_TABLE } from '@/constants';
import { Time } from '@/time';
import { NftLinksDb, NftLinkResolutionLockLostError } from './nft-links.db';
import { validateLinkUrl } from './nft-link-resolver.validator';
import {
  nextNftPageRetryState,
  nftPageRetryScope
} from './nft-link-page-retry';
import type { NormalizedNftCard } from './types';

const canonical = validateLinkUrl(
  'https://transient.xyz/mint/synthetic-fixture'
);
const card: NormalizedNftCard = {
  identifier: canonical,
  asset: {
    title: 'Cached fixture',
    media: { kind: 'image', imageUrl: 'https://example.com/cached.png' }
  },
  market: { saleType: 'UNKNOWN' },
  links: { viewUrl: canonical.viewUrl }
};
const args = {
  canonical,
  lockTTL: Time.minutes(2),
  updateMinInterval: Time.minutes(2)
};

describeWithSeed(
  'NFT page retry transactional persistence',
  {
    table: NFT_LINKS_TABLE,
    rows: [
      {
        canonical_id: canonical.canonicalId,
        platform: canonical.platform,
        last_tried_to_update: 1,
        last_successfully_updated: 1,
        full_data: card,
        media_uri: 'https://example.com/cached.png'
      }
    ]
  },
  () => {
    const db = new NftLinksDb(() => sqlExecutor);

    it('grants only one lock to concurrent consumers and commits a cache-preserving retry before eligibility resumes', async () => {
      const locks = await Promise.all([
        db.lockForProcessing(args, {}),
        db.lockForProcessing(args, {})
      ]);
      expect(locks.filter(Boolean)).toHaveLength(1);
      const owned = locks.find(Boolean)!;
      expect(owned.is_locked_since).toBeGreaterThan(0);
      const attemptedAt = Date.now() - 130_000;
      const retry = nextNftPageRetryState(
        owned,
        nftPageRetryScope(canonical),
        attemptedAt,
        1
      );
      await db.updateWithFailure(
        {
          canonicalId: canonical.canonicalId,
          message: 'Required NFT canonical page returned HTTP 404',
          attemptedAt,
          lockStamp: owned.is_locked_since!,
          retryState: retry
        },
        {}
      );
      const row = (await db.findByCanonicalId(canonical.canonicalId, {}))!;
      expect(row).toMatchObject({
        full_data: card,
        media_uri: 'https://example.com/cached.png',
        last_successfully_updated: 1,
        failed_since: attemptedAt,
        last_tried_to_update: attemptedAt,
        is_locked_since: null
      });
      expect(await db.lockForProcessing(args, {})).toBeNull();
      expect(
        await db.lockForProcessing(
          {
            ...args,
            canonical: validateLinkUrl(
              canonical.originalUrl + '?utm_source=fixture'
            )
          },
          {}
        )
      ).toBeNull();
    });

    it('allows recovery at the due boundary and resets failure state on successful persistence', async () => {
      const attemptedAt = Date.now() - 300_001;
      const retry = nextNftPageRetryState(
        {
          last_tried_to_update: 0,
          failed_since: null,
          last_successfully_updated: null
        },
        nftPageRetryScope(canonical),
        attemptedAt,
        1
      );
      await sqlExecutor.execute(
        `UPDATE ${NFT_LINKS_TABLE} SET last_tried_to_update=:attemptedAt,failed_since=:attemptedAt,refresh_retry_state=:retry`,
        { attemptedAt, retry: JSON.stringify(retry) }
      );
      const owned = (await db.lockForProcessing(args, {}))!;
      expect(owned).not.toBeNull();
      await db.updateWithSuccess(card, owned.is_locked_since!, {});
      expect(
        await db.findByCanonicalId(canonical.canonicalId, {})
      ).toMatchObject({
        refresh_retry_state: null,
        failed_since: null,
        last_error_message: null,
        is_locked_since: null,
        full_data: card
      });
      expect(await db.lockForProcessing(args, {})).toBeNull();
    });

    it('fences late failure and success from an expired worker after a replacement commits', async () => {
      const stale = (await db.lockForProcessing(args, {}))!;
      await sqlExecutor.execute(
        `UPDATE ${NFT_LINKS_TABLE} SET is_locked_since=1`
      );
      // A strictly newer millisecond models expiry without waiting two minutes.
      const clock = jest
        .spyOn(Time, 'currentMillis')
        .mockReturnValue(stale.is_locked_since! + 120_001);
      try {
        const replacement = (await db.lockForProcessing(args, {}))!;
        await db.updateWithSuccess(card, replacement.is_locked_since!, {});
        const current = await db.findByCanonicalId(canonical.canonicalId, {});
        await expect(
          db.updateWithFailure(
            {
              canonicalId: canonical.canonicalId,
              message: 'stale',
              attemptedAt: Date.now(),
              lockStamp: stale.is_locked_since!,
              retryState: null
            },
            {}
          )
        ).rejects.toBeInstanceOf(NftLinkResolutionLockLostError);
        await expect(
          db.updateWithSuccess(
            { ...card, asset: { title: 'stale' } },
            stale.is_locked_since!,
            {}
          )
        ).rejects.toBeInstanceOf(NftLinkResolutionLockLostError);
        expect(await db.findByCanonicalId(canonical.canonicalId, {})).toEqual(
          current
        );
      } finally {
        clock.mockRestore();
      }
    });

    it('invalidates obsolete retry state when legacy writers update attempt/success fields', async () => {
      const attemptedAt = Date.now() - 130_000;
      const retry = nextNftPageRetryState(
        {
          last_tried_to_update: 0,
          failed_since: null,
          last_successfully_updated: null
        },
        nftPageRetryScope(canonical),
        attemptedAt,
        1
      );
      await sqlExecutor.execute(
        `UPDATE ${NFT_LINKS_TABLE} SET last_tried_to_update=:nextAttempt,failed_since=:attemptedAt,refresh_retry_state=:retry`,
        {
          nextAttempt: attemptedAt + 1,
          attemptedAt,
          retry: JSON.stringify(retry)
        }
      );
      expect(await db.lockForProcessing(args, {})).not.toBeNull();
      await sqlExecutor.execute(
        `UPDATE ${NFT_LINKS_TABLE} SET is_locked_since=NULL,last_tried_to_update=:attemptedAt,failed_since=NULL`,
        { attemptedAt }
      );
      expect(await db.lockForProcessing(args, {})).not.toBeNull();
    });

    it('does not inherit a page delay through a different page with the same canonical identity', async () => {
      const owned = (await db.lockForProcessing(args, {}))!;
      const attemptedAt = Date.now() - 130_000;
      const retry = nextNftPageRetryState(
        owned,
        nftPageRetryScope(canonical),
        attemptedAt,
        1
      );
      await db.updateWithFailure(
        {
          canonicalId: canonical.canonicalId,
          message: 'synthetic',
          attemptedAt,
          lockStamp: owned.is_locked_since!,
          retryState: retry
        },
        {}
      );
      expect(
        await db.lockForProcessing(
          {
            ...args,
            canonical: {
              ...canonical,
              viewUrl: canonical.viewUrl + '/different'
            }
          },
          {}
        )
      ).not.toBeNull();
    });
  }
);
