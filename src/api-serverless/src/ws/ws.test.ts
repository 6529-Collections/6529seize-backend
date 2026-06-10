const mockPassportAuthenticate = jest.fn();

jest.mock('passport', () => ({
  authenticate: (...args: unknown[]) => mockPassportAuthenticate(...args)
}));

jest.mock('@/api/auth/auth-session-v2', () => ({
  isLegacyWsQueryTokenEnabled: jest.fn(() => false)
}));

jest.mock('@/api/identities/identity.fetcher', () => ({
  identityFetcher: {
    getProfileIdByIdentityKey: jest.fn()
  }
}));

import { identityFetcher } from '@/api/identities/identity.fetcher';
import { authenticateWebSocketToken } from '@/api/ws/ws';

const identityFetcherMock = identityFetcher as jest.Mocked<
  typeof identityFetcher
>;

describe('authenticateWebSocketToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPassportAuthenticate.mockImplementation(
      (_strategy, _options, callback) => (_req: unknown, _res: unknown) =>
        callback(null, { wallet: '0xabc', exp: 1234 })
    );
  });

  it('resolves null when identity lookup rejects', async () => {
    identityFetcherMock.getProfileIdByIdentityKey.mockRejectedValueOnce(
      new Error('db unavailable')
    );

    await expect(authenticateWebSocketToken('valid-token')).resolves.toBeNull();
  });
});
