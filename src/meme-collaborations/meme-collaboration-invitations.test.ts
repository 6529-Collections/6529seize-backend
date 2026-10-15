import { AuthenticationContext } from '@/auth-context';
import { DropType } from '@/entities/IDrop';
import { env } from '@/env';
import { userNotifier } from '@/notifications/user.notifier';
import { competitionMainStageRepository } from '@/competitions/competition-main-stage.repository';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { MemeCollaborationsDb } from './meme-collaborations.db';
import { MemeCollaborationsService } from './meme-collaborations.service';

const auth = () =>
  ({
    authenticatedProfileId: 'A',
    authenticatedWallet: '0xa',
    isAuthenticatedAsProxy: () => false
  }) as AuthenticationContext;
const context = {
  author_id: 'A',
  wave_id: 'wave',
  closed_at: null,
  artwork_hash: 'hash',
  terms_version: 'terms'
};
function setup() {
  let stored: typeof context | null = context;
  const query = jest.fn(async (operation: string) => {
    if (operation === 'lockArtwork')
      return [{ author_id: 'A', wave_id: 'wave', title: 'Current title' }];
    if (operation === 'artworkMetadata')
      return [
        { data_key: 'memeName', data_value: 'Meme' },
        { data_key: 'artist', data_value: 'Artist A' }
      ];
    if (operation === 'artworkParts')
      return [{ content: 'Current description' }];
    if (operation === 'artworkMedia')
      return [{ url: 'https://media/art.png', mime_type: 'image/png' }];
    if (operation === 'competitionTerms')
      return [{ participation_config: { terms: 'Native terms' } }];
    if (operation === 'createContext') {
      stored = context;
      return [];
    }
    if (operation === 'wave' || operation === 'invitationWave')
      return [
        { visibility_group_id: null, participation_terms: 'Current terms' }
      ];
    return [];
  });
  const db = {
    query,
    executeNativeQueriesInTransaction: jest.fn(async (fn) => fn({})),
    context: jest.fn(async () => stored),
    invitations: jest.fn(async () => [{ profile_id: 'B', status: 'ACCEPTED' }]),
    activeMainStageDrop: jest.fn(async () => ({
      author_id: 'A',
      competition_id: null
    })),
    profiles: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, handle: id }))
    )
  };
  return {
    db,
    service: new MemeCollaborationsService(
      db as unknown as MemeCollaborationsDb
    ),
    unmanaged: () => {
      stored = null;
    }
  };
}
afterEach(() => jest.restoreAllMocks());
beforeEach(() =>
  jest.spyOn(userNotifier, 'notifyOfMemeCollaboration').mockResolvedValue([42])
);
it('appends invitations without rewriting accepted consent, artwork, votes or the claim', async () => {
  const { db, service } = setup();
  expect(await service.inviteExisting('drop', ['C'], auth(), {})).toEqual([42]);
  expect(db.context).toHaveBeenCalledWith(
    'drop',
    expect.objectContaining({ connection: expect.any(Object) }),
    true
  );
  expect(db.query.mock.calls.map((call) => call[0])).toEqual([
    'lockArtwork',
    'invitationWave',
    'invite'
  ]);
});
it('snapshots persisted artwork and current terms when inviting on an old unmanaged submission', async () => {
  const { db, service, unmanaged } = setup();
  unmanaged();
  await service.inviteExisting('drop', ['C'], auth(), {});
  expect(db.query).toHaveBeenCalledWith(
    'createContext',
    expect.any(String),
    expect.objectContaining({
      artwork: JSON.stringify({
        name: 'Current title',
        description: 'Current description',
        image_url: 'https://media/art.png',
        animation_url: null
      })
    }),
    expect.any(Object)
  );
});
it.each([{ ids: ['B'] }, { ids: ['A'] }, { ids: ['C', 'C'] }, { ids: [] }])(
  'rejects duplicate, self, or empty invitation additions: %j',
  async ({ ids }) => {
    const { db, service } = setup();
    await expect(
      service.inviteExisting('drop', ids, auth(), {})
    ).rejects.toThrow('distinct collaborators');
    expect(db.query.mock.calls.some((call) => call[0] === 'invite')).toBe(
      false
    );
  }
);
it('enforces the combined roster limit', async () => {
  const { db, service } = setup();
  db.invitations.mockResolvedValue(
    Array.from({ length: 20 }, (_, i) => ({
      profile_id: String(i),
      status: 'ACCEPTED'
    }))
  );
  await expect(
    service.inviteExisting('drop', ['C'], auth(), {})
  ).rejects.toThrow('20 total');
});
it('rejects closed submissions even when native entry status still looks active', async () => {
  const { db, service } = setup();
  db.context.mockResolvedValue({ ...context, closed_at: 1 } as never);
  await expect(
    service.inviteExisting('drop', ['C'], auth(), {})
  ).rejects.toThrow('active Memes Main Stage');
});
it('rejects inactive, winner, or non-Main Stage submissions', async () => {
  const { db, service } = setup();
  db.activeMainStageDrop.mockResolvedValue(null as never);
  await expect(
    service.inviteExisting('drop', ['C'], auth(), {})
  ).rejects.toThrow('active Memes Main Stage');
});
it('rejects nonauthors and proxies', async () => {
  const { service } = setup();
  await expect(
    service.inviteExisting(
      'drop',
      ['C'],
      { ...auth(), authenticatedProfileId: 'B' } as AuthenticationContext,
      {}
    )
  ).rejects.toThrow('Only the submitter');
  await expect(
    service.inviteExisting(
      'drop',
      ['C'],
      {
        ...auth(),
        isAuthenticatedAsProxy: () => true
      } as AuthenticationContext,
      {}
    )
  ).rejects.toThrow('directly');
});
it.each([undefined, 'native-other'])(
  'rejects invitations on new artwork outside Main Stage: %s',
  async (competitionId) => {
    jest.spyOn(env, 'getStringOrNull').mockReturnValue('main-stage');
    jest
      .spyOn(competitionMainStageRepository, 'isDesignated')
      .mockResolvedValue(false);
    const { db, service } = setup();
    db.context.mockResolvedValue(null as never);
    const model = {
      drop_id: null,
      wave_id: 'other',
      author_id: 'A',
      drop_type: DropType.PARTICIPATORY,
      metadata: [{ data_key: 'memeName', data_value: 'Meme' }],
      parts: [{ media: [{}] }],
      collaborator_ids: ['C']
    } as CreateOrUpdateDropModel;
    await expect(
      service.onWrite(model, 'new', {}, competitionId)
    ).rejects.toThrow('Memes Main Stage');
    expect(
      db.query.mock.calls.some((call) => call[0] === 'createContext')
    ).toBe(false);
  }
);

it.each([undefined, 'native-main'])(
  'creates invitations on legacy or designated native Main Stage: %s',
  async (competitionId) => {
    jest.spyOn(env, 'getStringOrNull').mockReturnValue('wave');
    jest
      .spyOn(competitionMainStageRepository, 'isDesignated')
      .mockResolvedValue(true);
    const { db, service } = setup();
    db.context.mockResolvedValue(null as never);
    const model = {
      drop_id: null,
      wave_id: 'wave',
      author_id: 'A',
      title: 'Artwork',
      drop_type: competitionId ? DropType.COMPETITION : DropType.PARTICIPATORY,
      metadata: [{ data_key: 'memeName', data_value: 'GM' }],
      parts: [
        {
          content: 'Description',
          media: [{ url: 'https://media/art.png', mime_type: 'image/png' }]
        }
      ],
      collaborator_ids: ['C']
    } as CreateOrUpdateDropModel;
    await expect(
      service.onWrite(model, 'new', {}, competitionId)
    ).resolves.toEqual([42]);
    expect(
      db.query.mock.calls.some((call) => call[0] === 'createContext')
    ).toBe(true);
  }
);

it.each([
  ['self', ['A']],
  ['duplicates', ['C', 'C']],
  ['over the lifetime limit', Array.from({ length: 21 }, (_, i) => `C${i}`)]
])('rejects invalid initial invitees: %s', async (_label, ids) => {
  const { db, service } = setup();
  db.context.mockResolvedValue(null as never);
  const model = {
    drop_id: null,
    wave_id: 'wave',
    author_id: 'A',
    drop_type: DropType.PARTICIPATORY,
    metadata: [{ data_key: 'memeName', data_value: 'GM' }],
    parts: [{ media: [{}] }],
    collaborator_ids: ids
  } as CreateOrUpdateDropModel;
  await expect(service.onWrite(model, 'new', {})).rejects.toThrow(
    'Select up to 20 distinct collaborating profiles, excluding yourself'
  );
  expect(db.query).not.toHaveBeenCalled();
});
