import { AuthenticationContext } from '@/auth-context';
import { userNotifier } from '@/notifications/user.notifier';
import { MemeCollaborationsDb } from './meme-collaborations.db';
import { MemeCollaborationsService } from './meme-collaborations.service';

function setup() {
  const invitation = {
    id: 'invite',
    profile_id: 'B',
    status: 'PENDING',
    artist_name: null as string | null,
    profile: { id: 'B', handle: 'userB', display: 'userB', pfp: null }
  };
  const context = {
    author_id: 'A',
    author_handle: 'userA',
    base_artist: 'Artist A',
    closed_at: null,
    credit: null,
    artwork_hash: 'hash',
    artwork: {
      name: 'Test Cat',
      description: 'Artwork under review',
      image_url: 'https://example.com/artwork.png',
      animation_url: null
    },
    terms_version: 'terms',
    wave_id: 'wave'
  };
  const query = jest.fn(
    async (
      operation: string,
      _sql: string,
      params: Record<string, unknown>
    ) => {
      if (operation === 'dropExists') return [{ id: 'drop' }];
      if (operation === 'waveVisibility')
        return [{ visibility_group_id: null }];
      if (operation === 'respond') {
        invitation.status = String(params.status);
        invitation.artist_name = params.artistName as string | null;
      }
      return [];
    }
  );
  const db = {
    query,
    context: jest.fn(async () => context),
    invitations: jest.fn(async () => [invitation]),
    profiles: jest.fn(async () => [{ id: 'A', handle: 'userA' }]),
    activeMainStageDrop: jest.fn(async () => null),
    executeNativeQueriesInTransaction: jest.fn(async (fn) => fn({}))
  };
  const service = new MemeCollaborationsService(
    db as unknown as MemeCollaborationsDb
  );
  const auth = {
    authenticatedProfileId: 'B',
    authenticatedWallet: '0xb',
    isAuthenticatedAsProxy: () => false
  } as AuthenticationContext;
  const body = {
    action: 'ACCEPT' as const,
    artwork_hash: 'hash',
    terms_version: 'terms'
  };
  return { service, db, invitation, auth, body };
}
beforeEach(() =>
  jest.spyOn(userNotifier, 'notifyOfMemeCollaboration').mockResolvedValue([])
);
afterEach(() => jest.restoreAllMocks());

it('saves a trimmed credit name with consent and freezes it independently of the profile handle', async () => {
  const { service, invitation, auth, body } = setup();
  await service.respond(
    'drop',
    'invite',
    { ...body, artist_name: '  Artist B  ' },
    auth,
    {}
  );
  expect(invitation.artist_name).toBe('Artist B');
  expect(userNotifier.notifyOfMemeCollaboration).toHaveBeenCalledWith(
    'A',
    {
      event_type: 'ACCEPTED',
      artwork_name: 'Test Cat',
      drop_id: 'drop',
      wave_id: 'wave',
      actor_id: 'B',
      invitation_id: 'invite'
    },
    null,
    expect.any(Object)
  );
  expect(
    (await service.state('drop', 'B', {})).invitations[0].artist_name
  ).toBe('Artist B');
  invitation.profile.handle = 'renamedB';
  invitation.profile.display = 'renamedB';
  expect(
    await service.freezeForMint('drop', { connection: { connection: {} } })
  ).toEqual({
    artist: 'Artist A & Artist B',
    artist_profiles: 'userA, renamedB',
    collab: true
  });
});
it('does not change the final credit name on repeated acceptance', async () => {
  const { service, invitation, auth, body, db } = setup();
  await service.respond(
    'drop',
    'invite',
    { ...body, artist_name: 'Artist B' },
    auth,
    {}
  );
  await service.respond(
    'drop',
    'invite',
    { ...body, artist_name: 'Changed name' },
    auth,
    {}
  );
  expect(invitation.artist_name).toBe('Artist B');
  expect(
    db.query.mock.calls.filter(([operation]) => operation === 'respond')
  ).toHaveLength(1);
});
it('saves the handle when an older client omits the credit name', async () => {
  const { service, invitation, auth, body } = setup();
  await service.respond('drop', 'invite', body, auth, {});
  expect(invitation.artist_name).toBe('userB');
});
it.each(['', '   ', 'x'.repeat(201)])(
  'rejects an invalid supplied credit name',
  async (artist_name) => {
    const { service, invitation, auth, body } = setup();
    await expect(
      service.respond('drop', 'invite', { ...body, artist_name }, auth, {})
    ).rejects.toThrow('Artist credit name');
    expect(invitation.status).toBe('PENDING');
  }
);
