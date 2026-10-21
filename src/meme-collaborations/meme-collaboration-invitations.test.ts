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
  terms_version: 'terms',
  artwork: { name: 'Current title' }
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
  jest
    .spyOn(userNotifier, 'notifyOfMemeCollaborations')
    .mockImplementation(async (notifications) =>
      notifications.map((_notification, index) => 42 + index)
    )
);
it('appends invitations without rewriting accepted consent, artwork, votes or the claim', async () => {
  const { db, service } = setup();
  expect(await service.inviteExisting('drop', ['C'], auth(), {})).toEqual([42]);
  expect(userNotifier.notifyOfMemeCollaborations).toHaveBeenCalledWith(
    [
      expect.objectContaining({
        recipientId: 'C',
        data: expect.objectContaining({
          event_type: 'INVITED',
          actor_id: 'A',
          artwork_name: 'Current title'
        })
      })
    ],
    null,
    expect.any(Object)
  );
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
    ).rejects.toThrow(/distinct collaborators|already has|at least one/);
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
  ).rejects.toThrow('up to 5');
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

it.each([
  { competitionId: undefined, ids: ['C'] },
  { competitionId: undefined, ids: ['C', 'D'] },
  { competitionId: 'native-main', ids: ['C'] },
  { competitionId: 'native-main', ids: ['C', 'D'] }
])(
  'creates invitations on legacy or designated native Main Stage: %j',
  async ({ competitionId, ids }) => {
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
      collaborator_ids: ids
    } as CreateOrUpdateDropModel;
    await expect(
      service.onWrite(model, 'new', {}, competitionId)
    ).resolves.toEqual(ids.map((_id, index) => 42 + index));
    expect(
      db.query.mock.calls.some((call) => call[0] === 'createContext')
    ).toBe(true);
  }
);

it.each([
  ['self', ['A']],
  ['duplicates', ['C', 'C']],
  ['over the active limit', Array.from({ length: 6 }, (_, i) => `C${i}`)]
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
    /distinct collaborators|up to 5/
  );
  expect(db.query).not.toHaveBeenCalled();
});

it('inserts a multi-artist roster once and binds each bulk notification to its saved invitation', async () => {
  const { db, service } = setup();
  jest
    .mocked(userNotifier.notifyOfMemeCollaborations)
    .mockResolvedValue([42, 43]);
  expect(await service.inviteExisting('drop', ['C', 'D'], auth(), {})).toEqual([
    42, 43
  ]);
  expect(db.query).toHaveBeenCalledTimes(3);
  const notifications = jest.mocked(userNotifier.notifyOfMemeCollaborations)
    .mock.calls[0]![0];
  expect(notifications.map((item) => item.recipientId)).toEqual(['C', 'D']);
  expect(notifications[0]!.data.invitation_id).not.toBe(
    notifications[1]!.data.invitation_id
  );
  expect(db.query).toHaveBeenLastCalledWith(
    'invite',
    expect.stringContaining('values (:id0,'),
    expect.objectContaining({
      dropId: 'drop',
      id0: notifications[0]!.data.invitation_id,
      id1: notifications[1]!.data.invitation_id,
      profileId0: 'C',
      profileId1: 'D',
      profileHandle0: 'C',
      profileHandle1: 'D'
    }),
    expect.objectContaining({ connection: expect.any(Object) })
  );
  expect(userNotifier.notifyOfMemeCollaborations).toHaveBeenCalledTimes(1);
});

it('waits for the invitation batch before writing notifications and propagates insert failure', async () => {
  const { db, service } = setup();
  const originalQuery = db.query.getMockImplementation()!;
  let startInsert!: () => void;
  let failInsert!: (reason: Error) => void;
  const started = new Promise<void>((resolve) => {
    startInsert = resolve;
  });
  const insertion = new Promise<never>((_resolve, reject) => {
    failInsert = reject;
  });
  db.query.mockImplementation(async (operation) => {
    if (operation === 'invite') {
      startInsert();
      return insertion;
    }
    return originalQuery(operation);
  });
  const pending = service.inviteExisting('drop', ['C', 'D'], auth(), {});
  const failure = expect(pending).rejects.toThrow('Insert failed');
  await started;
  expect(userNotifier.notifyOfMemeCollaborations).not.toHaveBeenCalled();
  failInsert(new Error('Insert failed'));
  await failure;
  expect(userNotifier.notifyOfMemeCollaborations).not.toHaveBeenCalled();
});

it('propagates bulk notification failures to the enclosing invitation transaction', async () => {
  const { service } = setup();
  jest
    .mocked(userNotifier.notifyOfMemeCollaborations)
    .mockRejectedValue(new Error('Notification insert failed'));
  await expect(
    service.inviteExisting('drop', ['C', 'D'], auth(), {})
  ).rejects.toThrow('Notification insert failed');
});

it('allows cancelled recipients again, creates a new invitation ID and preserves cancelled history', async () => {
  const { db, service } = setup();
  db.invitations.mockResolvedValue([
    {
      id: 'old',
      profile_id: 'C',
      status: 'CANCELLED',
      created_at: Date.now() + 1000
    }
  ] as never);
  await service.inviteExisting('drop', ['C'], auth(), {});
  const notice = jest.mocked(userNotifier.notifyOfMemeCollaborations).mock
    .calls[0][0][0];
  expect(notice.data.invitation_id).not.toBe('old');
  expect(db.query).toHaveBeenCalledWith(
    'invite',
    expect.stringContaining('insert into'),
    expect.objectContaining({
      id0: notice.data.invitation_id,
      profileId0: 'C'
    }),
    expect.any(Object)
  );
  expect(db.query.mock.calls.some((call) => call[0] === 'respond')).toBe(false);
});
it('never resends a declined invitation and does not notify again', async () => {
  const { db, service } = setup();
  db.invitations.mockResolvedValue([{ profile_id: 'C', status: 'DECLINED' }]);
  await expect(
    service.inviteExisting('drop', ['C'], auth(), {})
  ).rejects.toThrow('declined');
  expect(userNotifier.notifyOfMemeCollaborations).not.toHaveBeenCalled();
});
it('counts only pending and accepted slots, allowing five after older cancellations and declines', async () => {
  const { db, service } = setup();
  db.invitations.mockResolvedValue(
    Array.from({ length: 20 }, (_, i) => ({
      profile_id: `old${i}`,
      status: i % 2 ? 'CANCELLED' : 'DECLINED'
    }))
  );
  await expect(
    service.inviteExisting('drop', ['B', 'C', 'D', 'E', 'F'], auth(), {})
  ).resolves.toHaveLength(5);
});
it('returns one current invitation per profile without disclosing private history to other viewers', async () => {
  const { db, service } = setup();
  db.invitations.mockResolvedValue([
    { id: 'old', profile_id: 'C', status: 'CANCELLED', profile: { id: 'C' } },
    { id: 'new', profile_id: 'C', status: 'PENDING', profile: { id: 'C' } }
  ] as never);
  expect(
    (await service.state('drop', 'C', {})).invitations.map((item) => item.id)
  ).toEqual(['new']);
  expect(
    (await service.state('drop', 'A', {})).invitations.map((item) => item.id)
  ).toEqual(['new']);
  expect((await service.state('drop', 'stranger', {})).invitations).toEqual([]);
});
