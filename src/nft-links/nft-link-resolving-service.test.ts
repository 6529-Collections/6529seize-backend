import { NftLinkResolvingService } from '@/nft-links/nft-link-resolving.service';
import { NftLinkResolver } from '@/nft-links/nft-link-resolver';
import { NftLinksDb } from '@/nft-links/nft-links.db';
import { SQS } from '@/sqs';
import { nftLinkMediaPreviewService } from '@/nft-links/nft-link-media-preview.service';
import {
  NftLinkResolutionDeadlineError,
  withNftLinkResolutionBudget
} from '@/nft-links/resolution-budget';
import { validateLinkUrl } from '@/nft-links/nft-link-resolver.validator';
import { NormalizedNftCard } from '@/nft-links/types';

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
    lockForProcessing: jest
      .fn()
      .mockResolvedValue({ canonical_id: card.identifier.canonicalId }),
    updateWithSuccess: jest.fn().mockResolvedValue(undefined),
    updateWithFailure: jest.fn().mockResolvedValue(undefined),
    findByCanonicalId: jest.fn().mockResolvedValue(null)
  };
  const notificationDb = {
    ...db,
    findByCanonicalIdForNotification: db.findByCanonicalId
  };
  const notifier = {
    notifyAboutNftLinkUpdate: jest.fn().mockResolvedValue(undefined)
  };
  const service = new NftLinkResolvingService(
    resolver as unknown as NftLinkResolver,
    notificationDb as unknown as NftLinksDb,
    notifier,
    {} as SQS
  );
  return { resolver, db, notifier, service };
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
        message: new NftLinkResolutionDeadlineError().message
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

  it('preserves five attempts and four waits for callers without a worker budget', async () => {
    const { resolver, db, service } = setup();
    resolver.resolve.mockRejectedValue(new Error('provider unavailable'));
    const operation = service.attemptResolve(url, {});
    await jest.advanceTimersByTimeAsync(40_000);
    await operation;
    expect(resolver.resolve).toHaveBeenCalledTimes(5);
    expect(db.updateWithFailure).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
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
