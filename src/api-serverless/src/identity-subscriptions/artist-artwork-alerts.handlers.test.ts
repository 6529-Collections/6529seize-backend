import { getAuthenticationContext } from '@/api/auth/auth';
import { AuthenticationContext } from '@/auth-context';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import * as Operations from '@/api/generated/routes/operations';
import { artistArtworkAlertsDb } from '@/notifications/artist-artwork-alerts.db';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import {
  handleGetArtistArtworkAlert,
  handleEnableArtistArtworkAlert,
  handleDisableArtistArtworkAlert
} from './artist-artwork-alerts.handlers';

jest.mock('@/api/auth/auth', () => ({ getAuthenticationContext: jest.fn() }));
jest.mock('@/api/identities/identity.fetcher', () => ({
  identityFetcher: { getProfileIdByIdentityKeyOrThrow: jest.fn() }
}));
jest.mock('@/notifications/artist-artwork-alerts.db', () => ({
  artistArtworkAlertsDb: { isEnabled: jest.fn(), setEnabled: jest.fn() }
}));
jest.mock('@/content-moderation/content-moderation.db', () => ({
  contentModerationDb: { isProfileBlocked: jest.fn() }
}));
const request = {
  params: { id: 'artist' },
  headers: {}
} as Operations.GetArtistArtworkAlertRequest;

function auth(profileId: string | null, role: string | null = null) {
  jest.mocked(getAuthenticationContext).mockResolvedValue(
    new AuthenticationContext({
      authenticatedWallet: 'wallet',
      authenticatedProfileId: profileId,
      roleProfileId: role,
      activeProxyActions: []
    })
  );
}
beforeEach(() => {
  jest.clearAllMocks();
  auth('viewer');
  jest
    .mocked(identityFetcher.getProfileIdByIdentityKeyOrThrow)
    .mockResolvedValue('artist');
  jest.mocked(contentModerationDb.isProfileBlocked).mockResolvedValue(false);
  jest.mocked(artistArtworkAlertsDb.isEnabled).mockResolvedValue(false);
});

it('owns preferences by authenticated profile and keeps the artist in the target path', async () => {
  expect(await handleGetArtistArtworkAlert(request)).toEqual({
    enabled: false
  });
  expect(await handleEnableArtistArtworkAlert(request)).toEqual({
    enabled: true
  });
  expect(artistArtworkAlertsDb.setEnabled).toHaveBeenCalledWith(
    { subscriberId: 'viewer', artistId: 'artist' },
    true
  );
  expect(await handleDisableArtistArtworkAlert(request)).toEqual({
    enabled: false
  });
  expect(artistArtworkAlertsDb.setEnabled).toHaveBeenLastCalledWith(
    { subscriberId: 'viewer', artistId: 'artist' },
    false
  );
});
it.each([
  [null, null],
  ['viewer', 'proxy'],
  ['artist', null]
])(
  'rejects absent, proxy and own-profile management (%s, %s)',
  async (profileId, role) => {
    auth(profileId, role);
    await expect(handleEnableArtistArtworkAlert(request)).rejects.toThrow();
    expect(artistArtworkAlertsDb.setEnabled).not.toHaveBeenCalled();
  }
);
it('rejects a blocked artist but still permits disabling existing alerts', async () => {
  jest.mocked(contentModerationDb.isProfileBlocked).mockResolvedValue(true);
  await expect(handleEnableArtistArtworkAlert(request)).rejects.toThrow(
    'Unblock'
  );
  expect(artistArtworkAlertsDb.setEnabled).not.toHaveBeenCalled();
  await handleDisableArtistArtworkAlert(request);
  expect(artistArtworkAlertsDb.setEnabled).toHaveBeenCalledWith(
    { subscriberId: 'viewer', artistId: 'artist' },
    false
  );
});
