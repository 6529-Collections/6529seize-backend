import fetch, { Response } from 'node-fetch';
import { Contract } from 'ethers';
import { HttpError } from '@/nft-links/lib/http';
import { getProvider } from '@/nft-links/lib/onchain';
import { getAdapterFor } from '@/nft-links/adapters/registry';
import { TransientAdapter } from '@/nft-links/adapters/transient';
import { NftLinkResolver } from '@/nft-links/nft-link-resolver';
import { NftLinkResolvingService } from '@/nft-links/nft-link-resolving.service';
import { NftLinksDb } from '@/nft-links/nft-links.db';
import { SQS } from '@/sqs';
import { validateLinkUrl } from '@/nft-links/nft-link-resolver.validator';
import {
  isNftLinkRefreshDue,
  nftPageRetryScope,
  requiredNftPage404,
  RequiredNftPageNotFoundError
} from '@/nft-links/nft-link-page-retry';

jest.mock('node-fetch', () => ({
  ...jest.requireActual('node-fetch'),
  __esModule: true,
  default: jest.fn()
}));
jest.mock('ethers', () => ({
  ...jest.requireActual('ethers'),
  Contract: jest.fn()
}));
jest.mock('@/nft-links/lib/onchain', () => ({
  ...jest.requireActual('@/nft-links/lib/onchain'),
  getProvider: jest.fn()
}));
jest.mock('@/nft-links/adapters/registry', () => ({
  getAdapterFor: jest.fn()
}));
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

const page = 'https://transient.xyz/mint/synthetic-fixture';
const wwwPage = 'https://www.transient.xyz/mint/synthetic-fixture';
const canonical = validateLinkUrl(page);
const response = (status: number, url: string, body = '') =>
  new Response(body, { status, url });

describe('Transient required-page redirect identity', () => {
  it.each([
    [page, wwwPage],
    [page + '?edition=1&currency=ETH', wwwPage + '?edition=1&currency=ETH'],
    [
      'https://transient.xyz/nfts/ethereum/0x1111111111111111111111111111111111111111/1',
      'https://www.transient.xyz/nfts/ethereum/0x1111111111111111111111111111111111111111/1'
    ]
  ])(
    'qualifies only the same page at its HTTPS www alias: %s',
    (request, final) => {
      const link = validateLinkUrl(request);
      const error = new HttpError(404, link.viewUrl, 'synthetic', final);
      expect(error.responseMatchesRequest).toBe(false);
      expect(requiredNftPage404(error, link)?.scopeHash).toBe(
        nftPageRetryScope(link)
      );
      expect(JSON.stringify(error)).not.toContain(final);
      expect(error).not.toHaveProperty('responseUrl');
    }
  );

  it.each([
    'http://www.transient.xyz/mint/synthetic-fixture',
    'https://www.transient.xyz:443/mint/synthetic-fixture',
    'https://www.transient.xyz:444/mint/synthetic-fixture',
    'https://user:secret@www.transient.xyz/mint/synthetic-fixture',
    'https://www.transient.xyz/mint/changed-asset',
    wwwPage + '/',
    wwwPage + '?edition=2',
    wwwPage + '#fragment',
    'https://lab.transient.xyz/mint/synthetic-fixture',
    'https://www.transient.xyz.example.com/mint/synthetic-fixture',
    'https://example.com/mint/synthetic-fixture',
    page + '/changed-asset',
    undefined
  ])(
    'keeps an unqualified final URL on its original error path: %s',
    (final) => {
      expect(
        requiredNftPage404(
          new HttpError(404, page, 'synthetic', final),
          canonical
        )
      ).toBeNull();
    }
  );

  it('rejects a changed query order, encoded path, reverse alias, or a noncanonical request', () => {
    const requests = [
      [page + '?a=1&b=2', wwwPage + '?b=2&a=1'],
      [page, wwwPage.replace('synthetic', '%73ynthetic')],
      [wwwPage, page],
      ['https://transient.xyz:443/mint/synthetic-fixture', wwwPage],
      ['http://transient.xyz/mint/synthetic-fixture', wwwPage],
      ['https://user:secret@transient.xyz/mint/synthetic-fixture', wwwPage]
    ];
    for (const [request, final] of requests) {
      expect(
        requiredNftPage404(new HttpError(404, request, 'synthetic', final), {
          ...canonical,
          viewUrl: request
        })
      ).toBeNull();
    }
  });

  it.each([429, 500, 503])('does not expand beyond HTTP404 (%s)', (status) => {
    expect(
      requiredNftPage404(
        new HttpError(status, page, 'synthetic', wwwPage),
        canonical
      )
    ).toBeNull();
  });

  it('does not apply the alias exception to Manifold or generic errors', () => {
    const error = new HttpError(404, page, 'synthetic', wwwPage);
    expect(
      requiredNftPage404(
        new HttpError(
          404,
          page + '/different',
          'synthetic',
          wwwPage + '/different'
        ),
        canonical
      )
    ).toBeNull();
    expect(
      requiredNftPage404(error, { ...canonical, platform: 'MANIFOLD' })
    ).toBeNull();
    expect(
      requiredNftPage404(new Error('HTTP404 for ' + wwwPage), canonical)
    ).toBeNull();
  });
});

describe('Transient alias through HTTP, adapter, resolver and worker retry paths', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(fetch).mockReset();
    jest.mocked(getAdapterFor).mockReturnValue(null);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('types an alias404 after the real Transient token adapter cannot supply metadata', async () => {
    const tokenPage =
      'https://transient.xyz/nfts/ethereum/0x1111111111111111111111111111111111111111/1';
    jest
      .mocked(getProvider)
      .mockReturnValue({} as ReturnType<typeof getProvider>);
    jest.mocked(Contract).mockReturnValue({
      tokenURI: jest
        .fn()
        .mockRejectedValue(new Error('synthetic unavailable token')),
      name: jest.fn().mockResolvedValue('Synthetic collection'),
      getListing: jest
        .fn()
        .mockRejectedValue(new Error('synthetic unavailable listing'))
    } as unknown as Contract);
    jest.mocked(getAdapterFor).mockReturnValue(new TransientAdapter());
    jest
      .mocked(fetch)
      .mockResolvedValue(
        response(404, tokenPage.replace('https://', 'https://www.'))
      );
    await expect(
      new NftLinkResolver().resolve(tokenPage, {})
    ).rejects.toBeInstanceOf(RequiredNftPageNotFoundError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      tokenPage,
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('keeps title-only enrichment failure and successful page recovery unchanged', async () => {
    jest.mocked(getAdapterFor).mockReturnValue({
      canHandle: () => true,
      resolveFast: async () => ({
        patch: {
          asset: {
            media: { kind: 'image', imageUrl: 'https://example.com/cached.png' }
          }
        }
      })
    });
    jest.mocked(fetch).mockResolvedValueOnce(response(404, wwwPage));
    await expect(
      new NftLinkResolver().resolve(page, {})
    ).rejects.toBeInstanceOf(HttpError);
    jest.mocked(getAdapterFor).mockReturnValue(null);
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(
        response(
          200,
          wwwPage,
          '<meta property="og:title" content="Recovered"><meta property="og:image" content="https://example.com/recovered.png">'
        )
      );
    await expect(
      new NftLinkResolver().resolve(page, {})
    ).resolves.toMatchObject({
      asset: {
        title: 'Recovered',
        media: { imageUrl: 'https://example.com/recovered.png' }
      }
    });
  });

  it.each([
    [wwwPage, 1, true],
    [wwwPage + '?different=1', 5, false]
  ] as const)(
    'preserves cache and persists the appropriate bounded retry outcome for %s',
    async (final, attempts, qualified) => {
      const cached = {
        asset: {
          title: 'Cached card',
          media: { imageUrl: 'https://example.com/cached.png' }
        }
      };
      const row = {
        canonical_id: canonical.canonicalId,
        is_locked_since: 123,
        last_tried_to_update: 0,
        last_successfully_updated: null,
        failed_since: null,
        full_data: cached
      };
      const db = {
        lockForProcessing: jest.fn().mockResolvedValue(row),
        updateWithFailure: jest.fn().mockResolvedValue(undefined),
        updateWithSuccess: jest.fn().mockResolvedValue(undefined)
      };
      const notify = { notifyAboutNftLinkUpdate: jest.fn() };
      const service = new NftLinkResolvingService(
        new NftLinkResolver(),
        db as unknown as NftLinksDb,
        notify,
        {} as SQS
      );
      jest.mocked(fetch).mockImplementation(async () => response(404, final));
      const operation = service.attemptResolve(page, {});
      await jest.advanceTimersByTimeAsync(40_000);
      await operation;
      expect(fetch).toHaveBeenCalledTimes(attempts);
      expect(db.updateWithFailure).toHaveBeenCalledTimes(1);
      const failure = db.updateWithFailure.mock.calls[0][0];
      expect(failure).toMatchObject({
        canonicalId: canonical.canonicalId,
        lockStamp: 123
      });
      if (qualified) {
        expect(failure.retryState).toMatchObject({
          code: 'REQUIRED_PAGE_HTTP_404',
          streak: 1,
          scopeHash: nftPageRetryScope(canonical)
        });
        const failed = {
          ...row,
          last_tried_to_update: failure.attemptedAt,
          failed_since: failure.attemptedAt,
          refresh_retry_state: failure.retryState
        };
        expect(
          isNftLinkRefreshDue(
            failed,
            canonical,
            failure.attemptedAt + 120_001,
            120_000
          )
        ).toBe(false);
        expect(
          isNftLinkRefreshDue(
            failed,
            canonical,
            failure.retryState.notBefore,
            120_000
          )
        ).toBe(true);
      } else expect(failure.retryState).toBeNull();
      expect(db.updateWithSuccess).not.toHaveBeenCalled();
      expect(notify.notifyAboutNftLinkUpdate).not.toHaveBeenCalled();
      expect(row.full_data).toBe(cached);
      expect(failure).not.toHaveProperty('full_data');
      expect(jest.getTimerCount()).toBe(0);
    }
  );
});
