const mockLoggerWarn = jest.fn();
jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({
      info: jest.fn(),
      warn: mockLoggerWarn,
      error: jest.fn(),
      errorWithDiagnostic: jest.fn(),
      debug: jest.fn()
    })
  }
}));

import { NftLinkResolvingService } from '@/nft-links/nft-link-resolving.service';
import { NftLinkResolver } from '@/nft-links/nft-link-resolver';
import { NftLinksDb } from '@/nft-links/nft-links.db';
import { SQS } from '@/sqs';
import { nftLinkMediaPreviewService } from '@/nft-links/nft-link-media-preview.service';
import { withNftLinkResolutionBudget } from '@/nft-links/resolution-budget';
import { validateLinkUrl } from '@/nft-links/nft-link-resolver.validator';
import { NormalizedNftCard } from '@/nft-links/types';
import { NftLinkEntity } from '@/entities/INftLink';
import { mapNftLinkEntityToApiLink } from '@/nft-links/nft-link-api.mapper';
import { nftLinkUpdatedMessage } from '@/api/ws/ws-message';
import { ApiNftLinkData } from '@/api/generated/models/ApiNftLinkData';
import {
  MEDIA_LINK_FRESHNESS_RESEND_MS,
  mediaLinkUpdateDecision
} from '@/nft-links/nft-link-update-change';

const url =
  'https://opensea.io/assets/ethereum/0x1111111111111111111111111111111111111111/1';
const card: NormalizedNftCard = {
  identifier: validateLinkUrl(url),
  asset: { media: { kind: 'image', imageUrl: 'https://example.com/nft.png' } },
  market: { saleType: 'UNKNOWN' },
  links: { viewUrl: url }
};
const NOW = 1_800_000_000_000;

function link(overrides: Partial<NftLinkEntity> = {}): NftLinkEntity {
  return {
    canonical_id: card.identifier.canonicalId,
    platform: 'OPENSEA',
    chain: 'ethereum',
    contract: '0x1111111111111111111111111111111111111111',
    token: '1',
    custom_id: null,
    full_data: {
      ...card,
      asset: { ...card.asset, title: 'Card', description: 'A card' }
    },
    media_uri: 'https://example.com/nft.png',
    media_preview_status: 'READY',
    media_preview_kind: 'image',
    media_preview_source_hash: 'hash',
    media_preview_card_url: 'https://cdn.example/card.webp',
    media_preview_thumb_url: 'https://cdn.example/thumb.webp',
    media_preview_small_url: 'https://cdn.example/small.webp',
    media_preview_width: 800,
    media_preview_height: 800,
    media_preview_mime_type: 'image/webp',
    media_preview_bytes: 1000,
    media_preview_queued_at: null,
    media_preview_last_tried_at: null,
    media_preview_last_success_at: null,
    media_preview_failed_since: null,
    media_preview_error_message: null,
    media_preview_locked_since: null,
    last_error_message: null,
    price: 1.5,
    price_currency: 'ETH',
    last_tried_to_update: NOW - 120_000,
    last_successfully_updated: NOW - 120_000,
    failed_since: null,
    is_locked_since: null,
    ...overrides
  } as NftLinkEntity;
}

describe('mediaLinkUpdateDecision', () => {
  const api = (overrides: Partial<NftLinkEntity> = {}) =>
    mapNftLinkEntityToApiLink(link(overrides));
  /** This refresh locked the row 1 s before NOW. */
  const LOCKED_AT = NOW - 1_000;
  const decide = (
    previous: ReturnType<typeof api>,
    next: ReturnType<typeof api>,
    now: number
  ) => mediaLinkUpdateDecision(previous, next, now, LOCKED_AT);

  it('sends a row that does not show this refresh, as before', () => {
    expect(decide(api(), api(), NOW)).toBe('unverified');
    expect(decide(api(), api({ last_successfully_updated: null }), NOW)).toBe(
      'unverified'
    );
  });

  it('is unchanged when only the refresh time moved', () => {
    expect(
      decide(
        api(),
        api({ last_successfully_updated: NOW, last_tried_to_update: NOW }),
        NOW
      )
    ).toBe('unchanged');
  });

  it('compares the client frame, so fields clients never receive do not count', () => {
    expect(
      decide(
        api(),
        api({
          last_successfully_updated: NOW,
          is_locked_since: NOW,
          media_preview_bytes: 2000,
          media_preview_source_hash: 'other',
          full_data: {
            ...card,
            asset: { ...card.asset, title: 'Card', description: 'A card' },
            market: { saleType: 'FIXED' }
          }
        }),
        NOW
      )
    ).toBe('unchanged');
  });

  it.each<[string, Partial<NftLinkEntity>, Partial<NftLinkEntity>]>([
    ['price', {}, { price: 2 }],
    ['price currency', {}, { price_currency: 'WETH' }],
    ['media', {}, { media_uri: 'https://example.com/other.png' }],
    [
      'title',
      {},
      {
        full_data: {
          ...card,
          asset: { ...card.asset, title: 'Renamed', description: 'A card' }
        }
      }
    ],
    ['media preview', {}, { media_preview_status: 'PENDING' }],
    [
      'error state',
      { last_error_message: 'timeout', failed_since: NOW - 60_000 },
      {}
    ]
  ])('is changed for a different %s', (_label, before, after) => {
    expect(
      decide(
        api(before),
        api({ ...after, last_successfully_updated: NOW }),
        NOW
      )
    ).toBe('changed');
  });

  it('resends for freshness when the previous success is unknown or a day old', () => {
    const next = api({ last_successfully_updated: NOW });
    expect(decide(api({ last_successfully_updated: null }), next, NOW)).toBe(
      'freshness'
    );
    expect(
      decide(
        api({
          last_successfully_updated: NOW - MEDIA_LINK_FRESHNESS_RESEND_MS
        }),
        next,
        NOW
      )
    ).toBe('freshness');
    expect(
      decide(
        api({
          last_successfully_updated: NOW - MEDIA_LINK_FRESHNESS_RESEND_MS + 1
        }),
        next,
        NOW
      )
    ).toBe('unchanged');
  });

  it('reads a MySQL BIGINT string timestamp', () => {
    expect(
      decide(
        {
          ...api(),
          last_successfully_updated: String(NOW - 60_000) as unknown as number
        },
        api({ last_successfully_updated: NOW }),
        NOW
      )
    ).toBe('unchanged');
  });
});

describe('MEDIA_LINK_UPDATED is sent only when a refresh changed it', () => {
  let stdout: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    jest
      .spyOn(nftLinkMediaPreviewService, 'onResolvedCard')
      .mockResolvedValue(undefined);
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Runs refreshes against a stored row that `persist` changes on success. */
  function setup(initial: NftLinkEntity) {
    let stored = initial;
    let persistChange: Partial<NftLinkEntity> = {};
    const db = {
      lockForProcessing: jest.fn(async () => ({
        ...stored,
        is_locked_since: Date.now()
      })),
      updateWithSuccess: jest.fn(async () => {
        stored = link({
          ...stored,
          ...persistChange,
          last_tried_to_update: Date.now(),
          last_successfully_updated: Date.now(),
          last_error_message: null,
          failed_since: null,
          is_locked_since: null
        });
      }),
      updateWithFailure: jest.fn(),
      findByCanonicalIdForNotification: jest.fn(async () => stored),
      findByCanonicalId: jest.fn(async () => stored)
    };
    const notifier = {
      notifyAboutNftLinkUpdate: jest.fn().mockResolvedValue(undefined)
    };
    // Staging (#2111): an unchanged refresh still wakes the outbox
    // (legacyBroadcast: false); only full broadcasts count as sends.
    const broadcasts = () =>
      notifier.notifyAboutNftLinkUpdate.mock.calls.filter(
        (call: unknown[]) =>
          (call[2] as { legacyBroadcast?: boolean } | undefined)
            ?.legacyBroadcast !== false
      );
    const wakeOnly = () =>
      notifier.notifyAboutNftLinkUpdate.mock.calls.length - broadcasts().length;
    const service = new NftLinkResolvingService(
      {
        resolve: jest.fn().mockResolvedValue(card)
      } as unknown as NftLinkResolver,
      db as unknown as NftLinksDb,
      notifier,
      { send: jest.fn() } as unknown as SQS
    );
    const refresh = async (change: Partial<NftLinkEntity> = {}) => {
      persistChange = change;
      const run = withNftLinkResolutionBudget(90_000, () =>
        service.attemptResolve(url, {})
      );
      await jest.advanceTimersByTimeAsync(0);
      await run;
      await jest.advanceTimersByTimeAsync(120_000);
    };
    const decisions = () =>
      stdout.mock.calls
        .map(([line]) => {
          try {
            return JSON.parse(String(line));
          } catch {
            return null;
          }
        })
        .filter((record) => record?.event === 'MEDIA_LINK_UPDATE_DECISION');
    return {
      notifier,
      refresh,
      decisions,
      db,
      broadcasts,
      wakeOnly,
      stored: () => stored
    };
  }

  it('skips the legacy broadcast for an unchanged refresh but still wakes the outbox', async () => {
    const { notifier, refresh, decisions, broadcasts, wakeOnly } =
      setup(link());

    await refresh();

    expect(broadcasts()).toHaveLength(0);
    expect(wakeOnly()).toBe(1);
    expect(notifier.notifyAboutNftLinkUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { legacyBroadcast: false }
    );
    expect(decisions()).toEqual([
      expect.objectContaining({
        decision: 'unchanged',
        MediaLinkUpdateSent: 0,
        MediaLinkUpdateSkipped: 1
      })
    ]);
    expect(decisions()[0]._aws.CloudWatchMetrics[0]).toMatchObject({
      Namespace: '6529/NftLinkRefresher',
      Metrics: [
        { Name: 'MediaLinkUpdateSent', Unit: 'Count' },
        { Name: 'MediaLinkUpdateSkipped', Unit: 'Count' }
      ]
    });
  });

  it.each<[string, Partial<NftLinkEntity>]>([
    ['price', { price: 2.25 }],
    ['media', { media_uri: 'https://example.com/new.png' }],
    [
      'metadata',
      {
        full_data: {
          ...card,
          asset: { ...card.asset, title: 'New title', description: 'A card' }
        }
      }
    ]
  ])(
    'sends a changed %s exactly once, with the full client frame',
    async (_label, change) => {
      const { refresh, decisions, stored, broadcasts, wakeOnly } =
        setup(link());

      await refresh(change);
      await refresh(change);
      await refresh(change);

      expect(broadcasts()).toHaveLength(1);
      expect(wakeOnly()).toBe(2);
      const [sent] = broadcasts()[0] as [ApiNftLinkData];
      const persisted = mapNftLinkEntityToApiLink(stored());
      expect(JSON.stringify(nftLinkUpdatedMessage(sent))).toBe(
        JSON.stringify(
          nftLinkUpdatedMessage({
            ...persisted,
            last_successfully_updated: sent.last_successfully_updated
          })
        )
      );
      expect(decisions().map((record) => record.decision)).toEqual([
        'changed',
        'unchanged',
        'unchanged'
      ]);
    }
  );

  it('still sends when the post-update read does not show this refresh', async () => {
    const { refresh, decisions, db, broadcasts } = setup(link());
    // A read that returns the row as it was before this refresh's write.
    const before = link();
    db.findByCanonicalIdForNotification.mockImplementation(async () => before);
    await refresh();
    expect(broadcasts()).toHaveLength(1);
    expect(decisions().map((record) => record.decision)).toEqual([
      'unverified'
    ]);
  });

  it('sends when a failing link recovers', async () => {
    const { refresh, broadcasts } = setup(
      link({ last_error_message: 'timeout', failed_since: NOW - 60_000 })
    );
    await refresh();
    expect(broadcasts()).toHaveLength(1);
  });

  it('sends once for freshness when the previous success is a day old', async () => {
    const { refresh, decisions, broadcasts } = setup(
      link({ last_successfully_updated: NOW - MEDIA_LINK_FRESHNESS_RESEND_MS })
    );
    await refresh();
    await refresh();
    expect(broadcasts()).toHaveLength(1);
    expect(decisions().map((record) => record.decision)).toEqual([
      'freshness',
      'unchanged'
    ]);
  });
});
