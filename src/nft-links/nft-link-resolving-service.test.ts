import { NftLinkResolvingService } from '@/nft-links/nft-link-resolving.service';
import { NftLinkResolver } from '@/nft-links/nft-link-resolver';
import {
  NftLinksDb,
  NftLinkResolutionLockLostError
} from '@/nft-links/nft-links.db';
import { SQS } from '@/sqs';
import { nftLinkMediaPreviewService } from '@/nft-links/nft-link-media-preview.service';
import {
  NftLinkResolutionDeadlineError,
  withNftLinkResolutionBudget
} from '@/nft-links/resolution-budget';
import { validateLinkUrl } from '@/nft-links/nft-link-resolver.validator';
import { NormalizedNftCard } from '@/nft-links/types';
import {
  nextNftPageRetryState,
  nftPageRetryScope,
  RequiredNftPageNotFoundError
} from './nft-link-page-retry';
import { env } from '@/env';
import { HttpError } from './lib/http';

jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    })
  }
}));

jest.mock('@/nft-links/nft-link-api.mapper', () => ({
  mapNftLinkEntityToApiLink: () => ({ canonical_id: 'test' })
}));

const url =
  'https://opensea.io/assets/ethereum/0x1111111111111111111111111111111111111111/1';
const card: NormalizedNftCard = {
  identifier: validateLinkUrl(url),
  asset: { media: { kind: 'image', imageUrl: 'https://example.com/nft.png' } },
  market: { saleType: 'UNKNOWN' },
  links: { viewUrl: url }
};

function setup() {
  const resolver = { resolve: jest.fn().mockResolvedValue(card) };
  const db = {
    lockForProcessing: jest.fn().mockResolvedValue({
      canonical_id: card.identifier.canonicalId,
      is_locked_since: 123,
      last_tried_to_update: 0,
      last_successfully_updated: null,
      failed_since: null
    }),
    updateWithSuccess: jest.fn().mockResolvedValue(undefined),
    updateWithFailure: jest.fn().mockResolvedValue(undefined),
    findByCanonicalId: jest.fn().mockResolvedValue(null),
    findByCanonicalIds: jest.fn().mockResolvedValue([]),
    insertPendingOrDoNothing: jest.fn().mockResolvedValue(undefined)
  };
  const notificationDb = {
    ...db,
    findByCanonicalIdForNotification: db.findByCanonicalId
  };
  const notifier = {
    notifyAboutNftLinkUpdate: jest.fn().mockResolvedValue(undefined)
  };
  const queue = { send: jest.fn().mockResolvedValue(undefined) };
  const service = new NftLinkResolvingService(
    resolver as unknown as NftLinkResolver,
    notificationDb as unknown as NftLinksDb,
    notifier,
    queue as unknown as SQS
  );
  return { resolver, db, notifier, service, queue };
}

describe('NFT link refresh retries and persistence', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest
      .spyOn(nftLinkMediaPreviewService, 'onResolvedCard')
      .mockResolvedValue(undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('records failure once instead of persisting an adapter result returned after the deadline', async () => {
    const { resolver, db, service } = setup();
    resolver.resolve.mockImplementation(async () => {
      jest.setSystemTime(Date.now() + 1000);
      return card;
    });
    await withNftLinkResolutionBudget(500, () =>
      service.attemptResolve(url, {})
    );
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(db.updateWithSuccess).not.toHaveBeenCalled();
    expect(db.updateWithFailure).toHaveBeenCalledWith(
      {
        canonicalId: card.identifier.canonicalId,
        message: new NftLinkResolutionDeadlineError().message,
        lockStamp: 123,
        attemptedAt: expect.any(Number),
        retryState: null
      },
      {}
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops retrying when the remaining budget cannot cover the backoff and another RPC', async () => {
    const { resolver, db, service } = setup();
    resolver.resolve.mockRejectedValue(new Error('slow RPC'));
    await withNftLinkResolutionBudget(12_000, () =>
      service.attemptResolve(url, {})
    );
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(db.updateWithFailure).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    new Error('provider unavailable'),
    new Error('execution reverted'),
    new HttpError(429, url, 'rate limited', url),
    new HttpError(503, url, 'provider unavailable', url),
    new HttpError(
      404,
      'https://example.com/asset.json',
      'asset missing',
      'https://example.com/asset.json'
    )
  ])(
    'preserves five attempts and four waits for other failures without a worker budget: %s',
    async (failure) => {
      const { resolver, db, service } = setup();
      resolver.resolve.mockRejectedValue(failure);
      const operation = service.attemptResolve(url, {});
      await jest.advanceTimersByTimeAsync(40_000);
      await operation;
      expect(resolver.resolve).toHaveBeenCalledTimes(5);
      expect(db.updateWithFailure).toHaveBeenCalledTimes(1);
      expect(db.updateWithFailure).toHaveBeenCalledWith(
        expect.objectContaining({ retryState: null }),
        {}
      );
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it('persists one required-page failure per eligible run without immediate retries or cache replacement', async () => {
    const { resolver, db, service, notifier } = setup();
    const page = validateLinkUrl(
      'https://transient.xyz/mint/synthetic-fixture'
    );
    resolver.resolve.mockRejectedValue(
      new RequiredNftPageNotFoundError(nftPageRetryScope(page))
    );
    await service.attemptResolve(page.originalUrl, {});
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(db.updateWithFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalId: page.canonicalId,
        lockStamp: 123,
        retryState: expect.objectContaining({
          streak: 1,
          scopeHash: nftPageRetryScope(page),
          attemptedAt: Date.now()
        })
      }),
      {}
    );
    expect(db.updateWithSuccess).not.toHaveBeenCalled();
    expect(notifier.notifyAboutNftLinkUpdate).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('propagates a failed failure-write for queue retry, and never acknowledges lost ownership as success', async () => {
    const { resolver, db, service } = setup();
    const page = validateLinkUrl(
      'https://transient.xyz/mint/synthetic-fixture'
    );
    resolver.resolve.mockRejectedValue(
      new RequiredNftPageNotFoundError(nftPageRetryScope(page))
    );
    const failure = new Error('synthetic persistence failure');
    db.updateWithFailure.mockRejectedValue(failure);
    await expect(service.attemptResolve(page.originalUrl, {})).rejects.toBe(
      failure
    );
    resolver.resolve.mockResolvedValue(card);
    db.updateWithSuccess.mockRejectedValue(
      new NftLinkResolutionLockLostError()
    );
    db.updateWithFailure.mockClear();
    await expect(service.attemptResolve(url, {})).rejects.toBeInstanceOf(
      NftLinkResolutionLockLostError
    );
    expect(db.updateWithFailure).not.toHaveBeenCalled();
  });

  it('does no provider work when the transactional eligibility/lock check skips a queued duplicate', async () => {
    const { db, service, resolver } = setup();
    db.lockForProcessing.mockResolvedValue(null);
    await service.attemptResolve(url, {});
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('uses persisted policy for both API reads and batched refreshes, and retains demand-driven recovery', async () => {
    const { service, db, queue } = setup();
    const page = validateLinkUrl(
      'https://transient.xyz/mint/synthetic-fixture'
    );
    const attemptedAt = Date.now() - 130_000;
    const retry = nextNftPageRetryState(
      {
        last_tried_to_update: 0,
        failed_since: null,
        last_successfully_updated: null
      },
      nftPageRetryScope(page),
      attemptedAt,
      1
    );
    const row = {
      canonical_id: page.canonicalId,
      last_tried_to_update: attemptedAt,
      failed_since: attemptedAt,
      last_successfully_updated: null,
      refresh_retry_state: retry
    };
    db.findByCanonicalId.mockResolvedValue(row);
    db.findByCanonicalIds.mockResolvedValue([row]);
    const original = env.getStringOrNull.bind(env);
    jest
      .spyOn(env, 'getStringOrNull')
      .mockImplementation((key) =>
        key === 'NFT_LINK_REFRESH_SQS_QUEUE' ? 'synthetic-queue' : original(key)
      );
    const aliases = [
      page.originalUrl,
      page.originalUrl + '?utm_source=fixture'
    ];
    await service.getLinkData(page.originalUrl, {});
    await service.refreshStaleTrackingForUrls(aliases, {});
    await service.ensureTrackingForUrls(aliases, {});
    expect(queue.send).not.toHaveBeenCalled();
    jest.setSystemTime(retry.notBefore);
    await service.getLinkData(page.originalUrl, {});
    await service.refreshStaleTrackingForUrls(aliases, {});
    await service.ensureTrackingForUrls(aliases, {});
    expect(queue.send).toHaveBeenCalledTimes(2);
  });

  it('keeps persisted success when preview enqueue is cancelled', async () => {
    const { db, resolver, service } = setup();
    jest.mocked(nftLinkMediaPreviewService.onResolvedCard).mockImplementation(
      (_card, _ctx, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true }
          );
        })
    );
    const operation = withNftLinkResolutionBudget(100, () =>
      service.attemptResolve(url, {})
    );
    await jest.advanceTimersByTimeAsync(100);
    await operation;
    expect(db.updateWithSuccess).toHaveBeenCalledTimes(1);
    expect(db.updateWithFailure).not.toHaveBeenCalled();
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('notifies immediately with the primary metadata without a replica catch-up wait', async () => {
    const { db, notifier, service } = setup();
    db.findByCanonicalId.mockResolvedValue({ canonical_id: 'test' });
    const operation = withNftLinkResolutionBudget(90_000, () =>
      service.attemptResolve(url, {})
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(notifier.notifyAboutNftLinkUpdate).toHaveBeenCalledTimes(1);
    await operation;
    expect(db.updateWithSuccess).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps persisted success when the notification data read stalls, and ignores its late result', async () => {
    const { db, resolver, notifier, service } = setup();
    let completeRead: ((value: object) => void) | undefined;
    db.findByCanonicalId.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeRead = resolve;
        })
    );
    const operation = withNftLinkResolutionBudget(90_000, () =>
      service.attemptResolve(url, {})
    );
    await jest.advanceTimersByTimeAsync(5000);
    await operation;
    completeRead!({ canonical_id: 'test' });
    await jest.advanceTimersByTimeAsync(0);
    expect(notifier.notifyAboutNftLinkUpdate).not.toHaveBeenCalled();
    expect(db.updateWithSuccess).toHaveBeenCalledTimes(1);
    expect(db.updateWithFailure).not.toHaveBeenCalled();
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
