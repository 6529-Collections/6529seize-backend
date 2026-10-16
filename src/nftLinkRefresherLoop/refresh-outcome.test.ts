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

it.each(['staging', 'nftLinkRefresherLoop_staging'])(
  'emits the correct environment for %s',
  (environment) => {
    const previous = process.env.SENTRY_ENVIRONMENT;
    process.env.SENTRY_ENVIRONMENT = environment;
    try {
      const write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
      nftRefreshObserver.completed(canonical, entity(null), { success: true });
      expect(JSON.parse(String(write.mock.calls[0][0])).Environment).toBe(
        'staging'
      );
    } finally {
      if (previous === undefined) delete process.env.SENTRY_ENVIRONMENT;
      else process.env.SENTRY_ENVIRONMENT = previous;
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
    outcome: 'internal_failure'
  });
});
