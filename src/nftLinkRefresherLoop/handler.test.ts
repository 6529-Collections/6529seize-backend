import type { Context, SQSEvent } from 'aws-lambda';

const mockResolve = jest.fn();
jest.mock('@/nft-links/nft-link-resolving.service', () => ({
  NftLinkResolvingService: jest.fn(() => ({ attemptResolve: mockResolve }))
}));
jest.mock('@/secrets', () => ({
  doInDbContext: (operation: () => Promise<unknown>) => operation()
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (handler: unknown) => handler
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

import { handler } from '@/nftLinkRefresherLoop/index';
import { getNftLinkResolutionBudget } from '@/nft-links/resolution-budget';
import { loggerContext } from '@/logger-context';

describe('NFT link refresher invocation bounds', () => {
  beforeEach(() => mockResolve.mockReset());
  afterEach(() => jest.restoreAllMocks());

  const event = (body: string): SQSEvent =>
    ({ Records: [{ messageId: 'message-one', body }] }) as SQSEvent;
  const context = (remaining: number): Context =>
    ({
      awsRequestId: 'request-one',
      getRemainingTimeInMillis: () => remaining
    }) as Context;

  it('uses actual remaining Lambda time and propagates the request ID to resolution work', async () => {
    mockResolve.mockImplementation(async () => {
      expect(loggerContext.get()?.requestId).toBe('request-one');
      expect(getNftLinkResolutionBudget()!.remainingMs()).toBeLessThanOrEqual(
        15_000
      );
      expect(getNftLinkResolutionBudget()!.remainingMs()).toBeGreaterThan(
        14_000
      );
    });
    await handler(
      event(JSON.stringify({ rawUrl: 'https://opensea.io/example' })),
      context(25_000),
      () => undefined
    );
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(getNftLinkResolutionBudget()).toBeUndefined();
    expect(loggerContext.get()).toBeUndefined();
  });

  it('does not acquire work without time left for cleanup', async () => {
    await expect(
      handler(
        event(JSON.stringify({ rawUrl: 'https://opensea.io/example' })),
        context(10_000),
        () => undefined
      )
    ).rejects.toThrow('deadline exceeded');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('discards malformed messages without starting resolution', async () => {
    for (const body of ['not-json', '{}', '{"rawUrl":42}']) {
      await handler(event(body), context(900_000), () => undefined);
    }
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
