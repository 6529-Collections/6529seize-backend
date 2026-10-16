import { FetchError } from 'node-fetch';
import { nftRefreshObserver, expectedFetchFailure } from './refresh-outcome';
import { validateLinkUrl } from '@/nft-links/nft-link-resolver.validator';
import {
  nftPageRetryScope,
  RequiredNftPageNotFoundError
} from '@/nft-links/nft-link-page-retry';
import { HttpError, NftLinkHttpTimeoutError } from '@/nft-links/lib/http';
import type { NftLinkEntity } from '@/entities/INftLink';

jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() })
  }
}));
const canonical = validateLinkUrl('https://transient.xyz/mint/synthetic');
const missing = () =>
  new RequiredNftPageNotFoundError(nftPageRetryScope(canonical));
const entity = (
  failed_since: number | null,
  last_successfully_updated: number | null = null
) => ({ failed_since, last_successfully_updated }) as NftLinkEntity;
beforeEach(() =>
  jest.replaceProperty(process, 'env', {
    ...process.env,
    OPS_ENVIRONMENT: 'prod'
  })
);
afterEach(() => jest.restoreAllMocks());

it('counts newly unavailable links once per failure episode and preserves previously-working evidence', () => {
  const write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  nftRefreshObserver.completed(canonical, entity(null, 100), {
    success: false,
    error: missing()
  });
  nftRefreshObserver.completed(canonical, entity(200, 100), {
    success: false,
    error: missing()
  });
  nftRefreshObserver.completed(canonical, entity(200, 100), { success: true });
  const events = write.mock.calls.map(([line]) => JSON.parse(String(line)));
  expect(
    events.map((event) => [
      event.Completed,
      event.Success,
      event.Unavailable,
      event.NewUnavailable,
      event.PreviouslyWorkingUnavailable
    ])
  ).toEqual([
    [1, 0, 1, 1, 1],
    [1, 0, 1, 0, 0],
    [1, 1, 0, 0, 0]
  ]);
  expect(JSON.stringify(events)).not.toContain(canonical.originalUrl);
  expect(events[0]._aws.CloudWatchMetrics[0].Dimensions).toEqual([
    ['Environment', 'Provider']
  ]);
  expect(events[0].linkHash).toMatch(/^[a-f0-9]{64}$/);
});

it('retains notifications for unknown failures, auth failures and mismatched page evidence', () => {
  for (const error of [
    new Error('unexpected'),
    new HttpError(403, canonical.viewUrl, 'denied'),
    new HttpError(404, canonical.viewUrl, 'untyped missing'),
    new RequiredNftPageNotFoundError('different-scope')
  ]) {
    expect(nftRefreshObserver.isExpectedFailure(error, canonical)).toBe(false);
  }
  expect(nftRefreshObserver.isExpectedFailure(missing(), canonical)).toBe(true);
});

it('recognizes typed timeouts and network faults without matching arbitrary message text', () => {
  const reset = new FetchError('reset', 'system', {
    code: 'ECONNRESET'
  } as NodeJS.ErrnoException);
  expect(expectedFetchFailure(reset)).toBe(true);
  expect(expectedFetchFailure(new NftLinkHttpTimeoutError())).toBe(true);
  expect(
    expectedFetchFailure(new Error('The user aborted a request. ECONNRESET'))
  ).toBe(false);
  const write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  nftRefreshObserver.completed(canonical, entity(null), {
    success: false,
    error: new NftLinkHttpTimeoutError()
  });
  expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
    Failure: 1,
    Unavailable: 0,
    category: 'TIMEOUT',
    outcome: 'transient_failure'
  });
});

it.each(['staging', 'prod'])(
  'emits the correct environment for %s',
  (environment) => {
    const previous = process.env.OPS_ENVIRONMENT;
    process.env.OPS_ENVIRONMENT = environment;
    try {
      const write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
      nftRefreshObserver.completed(canonical, entity(null), { success: true });
      expect(JSON.parse(String(write.mock.calls[0][0])).Environment).toBe(
        environment
      );
    } finally {
      if (previous === undefined) delete process.env.OPS_ENVIRONMENT;
      else process.env.OPS_ENVIRONMENT = previous;
    }
  }
);

it('does not change acknowledgement when metrics cannot be emitted', () => {
  jest.spyOn(process.stdout, 'write').mockImplementation(() => {
    throw new Error('synthetic');
  });
  expect(() =>
    nftRefreshObserver.completed(canonical, entity(null), { success: true })
  ).not.toThrow();
});

it('counts an untyped rejection as failure even when its value is undefined', () => {
  const write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  nftRefreshObserver.completed(canonical, entity(null), {
    success: false,
    error: undefined
  });
  expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
    Failure: 1,
    Success: 0,
    outcome: 'unexpected_failure'
  });
});

it.each([undefined, 'unknown'])(
  'does not publish cross-environment metrics or suppress errors with marker %s',
  (environment) => {
    if (environment === undefined) delete process.env.OPS_ENVIRONMENT;
    else process.env.OPS_ENVIRONMENT = environment;
    process.env.SENTRY_ENVIRONMENT = 'production';
    const write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    nftRefreshObserver.completed(canonical, entity(null), {
      success: false,
      error: missing()
    });
    expect(write).not.toHaveBeenCalled();
    expect(nftRefreshObserver.isExpectedFailure(missing(), canonical)).toBe(
      false
    );
  }
);

it.each([
  'https://superrare.com/artwork/eth/0x1111111111111111111111111111111111111111/1',
  'https://opensea.io/assets/ethereum/0x1111111111111111111111111111111111111111/1',
  'https://foundation.app/mint/eth/0x1111111111111111111111111111111111111111/1'
])('keeps unclassified upstream 404s in failure health for %s', (url) => {
  const link = validateLinkUrl(url);
  const error = new HttpError(
    404,
    link.viewUrl,
    'synthetic noncanonical failure',
    link.viewUrl
  );
  const write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  nftRefreshObserver.completed(link, entity(null), { success: false, error });
  expect(nftRefreshObserver.isExpectedFailure(error, link)).toBe(false);
  expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
    Failure: 1,
    Unavailable: 0,
    NewUnavailable: 0,
    outcome: 'unexpected_failure',
    category: 'HTTP_ERROR'
  });
});
