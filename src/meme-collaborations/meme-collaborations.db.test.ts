import 'reflect-metadata';
import { AuthenticationContext } from '@/auth-context';
import {
  DROPS_TABLE,
  MEME_COLLABORATIONS_TABLE,
  MEME_COLLABORATION_INVITATIONS_TABLE
} from '@/constants';
import { PROFILES_TABLE } from '@/constants';
import { DropType } from '@/entities/IDrop';
import { env } from '@/env';
import { identitiesDb } from '@/identities/identities.db';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { userNotifier } from '@/notifications/user.notifier';
import { MemeCollaborationsDb } from './meme-collaborations.db';
import {
  MemeCollaborationsService,
  collaborationArtworkDetails,
  collaborationArtworkHash
} from './meme-collaborations.service';

const originalGetStringOrNull = env.getStringOrNull.bind(env);
const wallet = (index: number) => `0x${String(index).padStart(40, '0')}`;
const artworkModel: CreateOrUpdateDropModel = {
  drop_id: null,
  wave_id: 'wave',
  author_id: 'A',
  author_identity: 'A',
  drop_type: DropType.PARTICIPATORY,
  title: 'Artwork',
  reply_to: null,
  signature: null,
  is_additional_action_promised: false,
  mentioned_groups: [],
  referenced_nfts: [],
  mentioned_users: [],
  mentioned_waves: [],
  parts: [
    {
      content: 'Description',
      quoted_drop: null,
      media: [{ url: 'https://media.example/art.png', mime_type: 'image/png' }]
    }
  ],
  metadata: [
    { data_key: 'artist', data_value: 'Artist A' },
    { data_key: 'memeName', data_value: 'GM' },
    { data_key: 'title', data_value: 'Artwork' },
    { data_key: 'description', data_value: 'Description' }
  ]
};
const artworkHash = collaborationArtworkHash(artworkModel);
const termsVersion = 'b'.repeat(64);
const contextSeed = {
  drop_id: 'drop',
  author_id: 'A',
  author_handle: 'ArtistA',
  wave_id: 'wave',
  artwork_hash: artworkHash,
  artwork: collaborationArtworkDetails(artworkModel),
  base_artist: 'Artist A',
  terms: 'Terms',
  terms_version: termsVersion,
  closed_at: null,
  credit: null
};
const invitation = (profile: string, index: number) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  drop_id: 'drop',
  profile_id: profile,
  profile_handle: `Artist${profile}`,
  status: 'PENDING',
  created_at: index,
  responded_at: null,
  responder_wallet: null,
  acceptance_copy_version: null
});
const invites = [invitation('B', 1), invitation('C', 2), invitation('D', 3)];
const auth = (profile: string) =>
  new AuthenticationContext({
    authenticatedProfileId: profile,
    authenticatedWallet: wallet(profile.charCodeAt(0)),
    roleProfileId: null,
    activeProxyActions: []
  });
const body = (action: 'ACCEPT' | 'DECLINE' | 'CANCEL') => ({
  action,
  artwork_hash: artworkHash,
  terms_version: termsVersion
});

describeWithSeed(
  'Meme collaborator consent and mint selection',
  [
    withProfiles(
      ['A', 'B', 'C', 'D', 'E'].map((id, index) =>
        aProfile({
          external_id: id,
          handle: `Artist${id}`,
          primary_wallet: wallet(index + 1)
        })
      )
    ),
    withWaves([
      aWave(
        { participation_terms: 'Terms' },
        { id: 'wave', name: 'Main Stage' }
      )
    ]),
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: 'drop',
          wave_id: 'wave',
          author_id: 'A',
          created_at: 1,
          parts_count: 1,
          drop_type: DropType.PARTICIPATORY,
          title: 'Artwork'
        }
      ]
    },
    { table: MEME_COLLABORATIONS_TABLE, rows: [contextSeed] },
    { table: MEME_COLLABORATION_INVITATIONS_TABLE, rows: invites }
  ],
  () => {
    it('persists the accepted credit name independently and keeps it final', async () => {
      const db = new MemeCollaborationsDb();
      const service = new MemeCollaborationsService(db);
      await service.respond(
        'drop',
        invites[0].id,
        { ...body('ACCEPT'), artist_name: '  Artist B Name  ' },
        auth('B'),
        {}
      );
      await service.respond(
        'drop',
        invites[0].id,
        { ...body('ACCEPT'), artist_name: 'Replacement' },
        auth('B'),
        {}
      );
      expect((await db.invitations('drop', {}))[0].artist_name).toBe(
        'Artist B Name'
      );
      expect((await db.acceptedByDrops(['drop'], {})).drop[0].display).toBe(
        'Artist B Name'
      );
      expect(
        (await db.presentationByDrops(['drop'], {})).drop.credit.artist
      ).toBe('Artist A & Artist B Name');
      const credit = await db.executeNativeQueriesInTransaction((connection) =>
        service.freezeForMint('drop', { connection })
      );
      expect(credit).toEqual({
        artist: 'Artist A & Artist B Name',
        artist_profiles: 'ArtistA, ArtistB',
        collab: true
      });
    });
    const db = new MemeCollaborationsDb(() => sqlExecutor);
    const service = new MemeCollaborationsService(db);
    beforeEach(() => {
      jest
        .spyOn(env, 'getStringOrNull')
        .mockImplementation((key) =>
          key === 'MAIN_STAGE_WAVE_ID' ? 'wave' : originalGetStringOrNull(key)
        );
      jest
        .spyOn(userNotifier, 'notifyOfMemeCollaboration')
        .mockResolvedValue([42]);
    });
    afterEach(() => jest.restoreAllMocks());

    it('adds invitations after voting has started while preserving accepted consent and freezes the extended roster', async () => {
      await service.respond(
        'drop',
        invites[0].id,
        body('ACCEPT'),
        auth('B'),
        {}
      );
      const before = await db.context('drop', {});
      await service.inviteExisting('drop', ['E'], auth('A'), {});
      expect(await db.context('drop', {})).toEqual(before);
      const state = await service.state('drop', 'A', {});
      expect(state.invitations).toHaveLength(4);
      expect(
        state.invitations.find((item) => item.profile.id === 'B')?.status
      ).toBe('ACCEPTED');
      const added = state.invitations.find((item) => item.profile.id === 'E')!;
      await service.respond('drop', added.id, body('ACCEPT'), auth('E'), {});
      const credit = await db.executeNativeQueriesInTransaction((connection) =>
        service.freezeForMint('drop', { connection })
      );
      expect(credit?.artist_profiles).toContain('ArtistE');
      await expect(
        service.inviteExisting('drop', ['C'], auth('A'), {})
      ).rejects.toThrow('active Memes Main Stage');
    });

    it('keeps pending profiles private to the author and their own invitee', async () => {
      expect((await service.state('drop', null, {})).invitations).toEqual([]);
      expect((await service.state('drop', 'A', {})).invitations).toHaveLength(
        3
      );
      expect(
        (await service.state('drop', 'B', {})).invitations.map(
          (item) => item.profile.id
        )
      ).toEqual(['B']);
      expect((await service.state('drop', null, {})).collaborators).toEqual([]);
    });

    it('accepts during voting, publishes only accepted collaborators, and makes acceptance final and idempotent', async () => {
      await service.respond(
        'drop',
        invites[0].id,
        body('ACCEPT'),
        auth('B'),
        {}
      );
      await service.respond(
        'drop',
        invites[0].id,
        body('ACCEPT'),
        auth('B'),
        {}
      );
      expect(userNotifier.notifyOfMemeCollaboration).toHaveBeenCalledTimes(1);
      expect(
        (await service.state('drop', null, {})).collaborators.map(
          (profile) => profile.id
        )
      ).toEqual(['B']);
      await expect(
        service.respond('drop', invites[0].id, body('DECLINE'), auth('B'), {})
      ).rejects.toThrow('cannot be withdrawn');
      await expect(
        service.respond('drop', invites[0].id, body('CANCEL'), auth('A'), {})
      ).rejects.toThrow('cannot be withdrawn');
    });

    it('snapshots multiple accepted artists and closes unanswered invitations without blocking the mint', async () => {
      await service.respond(
        'drop',
        invites[0].id,
        body('ACCEPT'),
        auth('B'),
        {}
      );
      await service.respond(
        'drop',
        invites[1].id,
        body('ACCEPT'),
        auth('C'),
        {}
      );
      await db.query(
        'removeProfile',
        `delete from ${PROFILES_TABLE} where external_id='B'`,
        {},
        {}
      );
      const credit = await db.executeNativeQueriesInTransaction((connection) =>
        service.freezeForMint('drop', { connection })
      );
      expect(credit).toEqual({
        artist: 'Artist A, ArtistB, ArtistC',
        artist_profiles: 'ArtistA, ArtistB, ArtistC',
        collab: true
      });
      expect((await service.state('drop', 'D', {})).invitations[0].status).toBe(
        'CLOSED'
      );
      await expect(
        service.respond('drop', invites[2].id, body('ACCEPT'), auth('D'), {})
      ).rejects.toThrow('closed');
      expect(
        await db.executeNativeQueriesInTransaction((connection) =>
          service.freezeForMint('drop', { connection })
        )
      ).toEqual(credit);
    });

    it('mints with the submitter alone when nobody has accepted', async () => {
      expect(
        await db.executeNativeQueriesInTransaction((connection) =>
          service.freezeForMint('drop', { connection })
        )
      ).toEqual({
        artist: 'Artist A',
        artist_profiles: 'ArtistA',
        collab: false
      });
    });

    it('lists accepted submissions and wins on both artist profiles without listing pending invitations', async () => {
      jest.spyOn(env, 'getStringOrNull').mockReturnValue('wave');
      await service.respond(
        'drop',
        invites[0].id,
        body('ACCEPT'),
        auth('B'),
        {}
      );
      expect(
        await identitiesDb.getActiveMainStageDropIds(['A', 'B', 'C'], {})
      ).toEqual({ A: ['drop'], B: ['drop'] });
      expect(
        (await db.acceptedByDrops(['drop'], {})).drop.map(
          (profile) => profile.id
        )
      ).toEqual(['B']);
      expect((await db.presentationByDrops(['drop'], {})).drop.credit).toEqual({
        artist: 'Artist A & ArtistB',
        artist_profiles: 'ArtistA, ArtistB',
        collab: true
      });
      await db.query(
        'winner',
        `update ${DROPS_TABLE} set drop_type='WINNER' where id='drop'`,
        {},
        {}
      );
      expect(
        await identitiesDb.getActiveMainStageDropIds(['A', 'B', 'C'], {})
      ).toEqual({});
      expect(
        await identitiesDb.getMainStageWinnerDropIds(['A', 'B', 'C'], {})
      ).toEqual({ A: ['drop'], B: ['drop'] });
    });

    it('rejects another identity, delegated consent, and stale artwork before changing state', async () => {
      await expect(
        service.respond('drop', invites[0].id, body('ACCEPT'), auth('C'), {})
      ).rejects.toThrow('another profile');
      const proxy = new AuthenticationContext({
        authenticatedProfileId: 'A',
        authenticatedWallet: wallet(1),
        roleProfileId: 'B',
        activeProxyActions: []
      });
      await expect(
        service.respond('drop', invites[0].id, body('ACCEPT'), proxy, {})
      ).rejects.toThrow('own authenticated profile');
      await expect(
        service.respond(
          'drop',
          invites[0].id,
          { ...body('ACCEPT'), artwork_hash: 'c'.repeat(64) },
          auth('B'),
          {}
        )
      ).rejects.toThrow('changed');
      expect((await service.state('drop', null, {})).collaborators).toEqual([]);
    });

    it('locks accepted artwork but permits unrelated trait corrections', async () => {
      await service.respond(
        'drop',
        invites[0].id,
        body('ACCEPT'),
        auth('B'),
        {}
      );
      await expect(
        db.executeNativeQueriesInTransaction((connection) =>
          service.onWrite(
            {
              ...artworkModel,
              drop_id: 'drop',
              metadata: artworkModel.metadata.map((item) =>
                item.data_key === 'artist'
                  ? { ...item, data_value: 'Artist A & ArtistB' }
                  : item
              )
            },
            'drop',
            { connection }
          )
        )
      ).resolves.toEqual([]);
      expect((await db.context('drop', {}))?.base_artist).toBe('Artist A');
      await expect(
        db.executeNativeQueriesInTransaction((connection) =>
          service.onWrite(
            {
              ...artworkModel,
              drop_id: 'drop',
              parts: [
                {
                  ...artworkModel.parts[0],
                  media: [
                    {
                      url: 'https://media.example/replacement.png',
                      mime_type: 'image/png'
                    }
                  ]
                }
              ]
            },
            'drop',
            { connection }
          )
        )
      ).rejects.toThrow('locks this artwork');
      await expect(
        db.executeNativeQueriesInTransaction((connection) =>
          service.onWrite(
            {
              ...artworkModel,
              drop_id: 'drop',
              metadata: [
                ...artworkModel.metadata,
                { data_key: 'palette', data_value: 'Color' }
              ]
            },
            'drop',
            { connection }
          )
        )
      ).resolves.toEqual([]);
    });

    it('closes invitations on deletion while retaining accepted consent records', async () => {
      await service.respond(
        'drop',
        invites[0].id,
        body('ACCEPT'),
        auth('B'),
        {}
      );
      await db.executeNativeQueriesInTransaction((connection) =>
        service.closeDeleted('drop', { connection })
      );
      expect(
        (await db.invitations('drop', {})).map((item) => item.status)
      ).toEqual(['ACCEPTED', 'CANCELLED', 'CANCELLED']);
    });

    it('serializes a pending acceptance behind mint selection so late consent cannot alter the roster', async () => {
      let unlock!: () => void;
      let announceLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        announceLocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const selection = db.executeNativeQueriesInTransaction(
        async (connection) => {
          await db.context('drop', { connection }, true);
          announceLocked();
          await release;
          return service.freezeForMint('drop', { connection });
        }
      );
      await locked;
      const acceptance = service.respond(
        'drop',
        invites[0].id,
        body('ACCEPT'),
        auth('B'),
        {}
      );
      const assertion = expect(acceptance).rejects.toThrow('closed');
      unlock();
      expect((await selection)?.collab).toBe(false);
      await assertion;
      expect((await service.state('drop', null, {})).collaborators).toEqual([]);
    });

    it('manages new artwork from older clients even without an invitation field', async () => {
      await db.executeNativeQueriesInTransaction((connection) =>
        service.onWrite(artworkModel, 'new-drop', { connection })
      );
      expect((await service.state('new-drop', 'A', {})).managed).toBe(true);
      expect((await service.state('new-drop', null, {})).collaborators).toEqual(
        []
      );
      expect(
        await db.executeNativeQueriesInTransaction((connection) =>
          service.onWrite(
            { ...artworkModel, collaborator_ids: ['B', 'C'] },
            'collab-drop',
            { connection }
          )
        )
      ).toEqual([42, 42]);
      const createdInvitations = (await service.state('collab-drop', 'A', {}))
        .invitations;
      expect(createdInvitations).toHaveLength(2);
      expect(
        createdInvitations.map((invitation) => [
          invitation.profile.id,
          invitation.status
        ])
      ).toEqual(
        expect.arrayContaining([
          ['B', 'PENDING'],
          ['C', 'PENDING']
        ])
      );
      expect(
        (await service.state('collab-drop', null, {})).invitations
      ).toEqual([]);
    });
  }
);
