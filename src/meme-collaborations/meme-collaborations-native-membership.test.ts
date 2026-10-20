import {
  COMPETITIONS_TABLE,
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_ENTRIES_TABLE,
  DROPS_TABLE,
  DROPS_PARTS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_METADATA_TABLE,
  MEME_COLLABORATIONS_TABLE,
  MEME_COLLABORATION_INVITATIONS_TABLE,
  WAVES_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE
} from '@/constants';
import { AuthenticationContext } from '@/auth-context';
import { installLegacyCompetitionGetFacade } from '@/competitions/legacy-competition-get-facade';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { env } from '@/env';
import { userNotifier } from '@/notifications/user.notifier';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { nativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { MemeCollaborationsDb } from './meme-collaborations.db';
import { MemeCollaborationsService } from './meme-collaborations.service';

const originalWave = aWave(
  { type: WaveType.RANK, participation_terms: 'Poisoned physical terms' },
  { id: 'original-hub', name: 'Original hub' }
);
const otherWave = aWave({}, { id: 'other-hub', name: 'Another public hub' });
const original = {
  ...nativeOriginalPrimaryFixture(originalWave),
  participation_config: { terms: 'Native original terms' }
};
const sibling = {
  ...nativeOriginalPrimaryFixture(otherWave),
  id: '11000000-0000-4000-8000-000000000001',
  legacy_wave_id: null,
  participation_config: { terms: 'Native sibling terms' }
};
const ordinary = {
  ...original,
  id: '11000000-0000-4000-8000-000000000002',
  legacy_wave_id: null
};
const drops = [
  { id: 'native-stale-winner', type: DropType.WINNER, owner: original },
  { id: 'native-stale-chat', type: DropType.CHAT, owner: original },
  { id: 'sibling-main-stage', type: DropType.COMPETITION, owner: sibling },
  {
    id: 'sibling-without-capability',
    type: DropType.PARTICIPATORY,
    owner: ordinary
  },
  { id: 'native-winner', type: DropType.PARTICIPATORY, owner: original },
  { id: 'native-withdrawn', type: DropType.PARTICIPATORY, owner: original },
  { id: 'orphan-parti', type: DropType.PARTICIPATORY, owner: original },
  { id: 'orphan-winner', type: DropType.WINNER, owner: original }
];
const entries = drops
  .filter((drop) => !drop.id.startsWith('orphan-'))
  .map((drop) => ({
    id: `entry-${drop.id}`,
    competition_id: drop.owner.id,
    wave_id: drop.owner.wave_id,
    drop_id: drop.id,
    submitter_id: 'author',
    status:
      drop.id === 'native-winner'
        ? 'WINNER'
        : drop.id === 'native-withdrawn'
          ? 'WITHDRAWN'
          : 'ACTIVE',
    config_version: 1,
    submitted_at: 1
  }));
const auth = new AuthenticationContext({
  authenticatedProfileId: 'author',
  authenticatedWallet: '0x0000000000000000000000000000000000000001',
  roleProfileId: null,
  activeProxyActions: []
});

describeWithSeed(
  'Native Main Stage collaborator membership',
  [
    withWaves([originalWave, otherWave]),
    withProfiles([
      aProfile({
        external_id: 'author',
        handle: 'Artist',
        primary_wallet: '0x0000000000000000000000000000000000000001'
      }),
      aProfile({
        external_id: 'invitee',
        handle: 'Collaborator',
        primary_wallet: '0x0000000000000000000000000000000000000002'
      })
    ]),
    { table: COMPETITIONS_TABLE, rows: [original, sibling, ordinary] },
    {
      table: COMPETITION_CAPABILITIES_TABLE,
      rows: [original, sibling].map((competition) => ({
        capability: 'MAIN_STAGE',
        competition_id: competition.id,
        wave_id: competition.wave_id,
        assigned_at: 1
      }))
    },
    {
      table: DROPS_TABLE,
      rows: drops.map((drop) => ({
        id: drop.id,
        author_id: 'author',
        wave_id: drop.owner.wave_id,
        drop_type: drop.type,
        created_at: 1,
        parts_count: 1,
        title: 'Artwork'
      }))
    },
    { table: COMPETITION_ENTRIES_TABLE, rows: entries },
    {
      table: DROP_METADATA_TABLE,
      rows: drops.map((drop) => ({
        drop_id: drop.id,
        data_key: 'memeName',
        data_value: 'Artwork'
      }))
    },
    {
      table: DROPS_PARTS_TABLE,
      rows: drops.map((drop) => ({
        drop_id: drop.id,
        drop_part_id: 1,
        content: 'Description'
      }))
    },
    {
      table: DROP_MEDIA_TABLE,
      rows: drops.map((drop) => ({
        drop_id: drop.id,
        drop_part_id: 1,
        url: 'https://media.example/art.png',
        mime_type: 'image/png'
      }))
    }
  ],
  () => {
    const db = new MemeCollaborationsDb(() => sqlExecutor);
    const service = new MemeCollaborationsService(db);
    beforeEach(() => {
      const originalEnv = env.getStringOrNull.bind(env);
      jest
        .spyOn(env, 'getStringOrNull')
        .mockImplementation((key) =>
          key === 'MAIN_STAGE_WAVE_ID' ? originalWave.id : originalEnv(key)
        );
      jest
        .spyOn(userNotifier, 'notifyOfMemeCollaborations')
        .mockResolvedValue([42]);
    });
    afterEach(() => jest.restoreAllMocks());

    it.each(['native-stale-winner', 'native-stale-chat'])(
      'invites on actual ACTIVE original membership despite stale shared classification: %s',
      async (dropId) => {
        expect(
          await service.inviteExisting(dropId, ['invitee'], auth, {})
        ).toEqual([42]);
        expect((await service.state(dropId, 'author', {})).can_invite).toBe(
          true
        );
        expect((await db.context(dropId, {}))?.terms).toBe(
          'Native original terms'
        );
        expect(
          await sqlExecutor.execute(
            `select id from ${COMPETITION_ENTRIES_TABLE} where drop_id=:dropId`,
            { dropId }
          )
        ).toEqual([{ id: `entry-${dropId}` }]);
      }
    );

    it('allows a designated sibling in another public hub and snapshots its own native terms', async () => {
      expect(
        await service.inviteExisting(
          'sibling-main-stage',
          ['invitee'],
          auth,
          {}
        )
      ).toEqual([42]);
      expect((await db.context('sibling-main-stage', {}))?.terms).toBe(
        'Native sibling terms'
      );
    });

    it('keeps native eligibility and invitation terms when obsolete wave terms and the physical winner relation are absent', async () => {
      if (
        process.env.NODE_ENV !== 'local' ||
        !process.env.DB_NAME?.includes('_jest_worker_')
      )
        throw new Error(
          'Physical-absence acceptance requires a disposable Jest database'
        );
      try {
        // These objects are removed only in the disposable worker database.
        // Deployed environments retain their physical compatibility objects.
        await sqlExecutor.execute(
          `drop table \`${WAVES_DECISION_WINNER_DROPS_TABLE}\``
        );
        await sqlExecutor.execute(
          `alter table \`${WAVES_TABLE}\` drop column participation_terms`
        );
        expect(
          await sqlExecutor.execute(
            `select table_name from information_schema.tables where table_schema=database() and table_name=:table`,
            { table: WAVES_DECISION_WINNER_DROPS_TABLE }
          )
        ).toEqual([]);
        expect(
          await sqlExecutor.execute(
            `select column_name from information_schema.columns where table_schema=database() and table_name=:table and column_name='participation_terms'`,
            { table: WAVES_TABLE }
          )
        ).toEqual([]);
        expect(
          await db.activeMainStageDrop('native-stale-chat', {})
        ).toMatchObject({ competition_id: original.id });
        expect(
          await service.inviteExisting(
            'native-stale-chat',
            ['invitee'],
            auth,
            {}
          )
        ).toEqual([42]);
        expect((await db.context('native-stale-chat', {}))?.terms).toBe(
          'Native original terms'
        );
        expect(
          await sqlExecutor.execute(
            `select count(*) as n from ${COMPETITION_ENTRIES_TABLE}`
          )
        ).toEqual([{ n: entries.length }]);
      } finally {
        // Match the existing absent-storage acceptance test's schema restore,
        // including compatibility views, before the shared seed cleanup runs.
        const schema = new DataSource({
          type: 'mysql',
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT),
          username: process.env.DB_USER,
          password: process.env.DB_PASS,
          database: process.env.DB_NAME,
          charset: 'utf8mb4',
          timezone: 'Etc/UTC',
          entities: Object.values(Entities).filter(
            (entity) => typeof entity === 'function'
          ),
          synchronize: false
        });
        await schema.initialize();
        try {
          await schema.synchronize();
        } finally {
          await schema.destroy();
        }
        await installLegacyCompetitionGetFacade(sqlExecutor);
      }
    });

    it.each([
      'orphan-parti',
      'orphan-winner',
      'native-winner',
      'native-withdrawn',
      'sibling-without-capability'
    ])(
      'does not derive invitation rights or create membership from the shared hub/category: %s',
      async (dropId) => {
        expect((await service.state(dropId, 'author', {})).can_invite).toBe(
          false
        );
        await expect(
          service.inviteExisting(dropId, ['invitee'], auth, {})
        ).rejects.toThrow('active Memes Main Stage');
        expect(
          await sqlExecutor.execute(
            `select drop_id from ${MEME_COLLABORATIONS_TABLE}`
          )
        ).toEqual([]);
        expect(
          await sqlExecutor.execute(
            `select drop_id from ${MEME_COLLABORATION_INVITATIONS_TABLE}`
          )
        ).toEqual([]);
        expect(
          await sqlExecutor.execute(
            `select count(*) as n from ${COMPETITION_ENTRIES_TABLE}`
          )
        ).toEqual([{ n: entries.length }]);
      }
    );

    it.each(['submitter_id', 'wave_id'])(
      'rejects a membership whose content binding is inconsistent: %s',
      async (column) => {
        // Fixed test-owned column names; the real invitation query must bind
        // the entry to the persisted content, as native submission commands do.
        if (column === 'submitter_id')
          await sqlExecutor.execute(
            `update ${COMPETITION_ENTRIES_TABLE} set submitter_id='other-author' where drop_id='sibling-main-stage'`
          );
        else
          await sqlExecutor.execute(
            `update ${DROPS_TABLE} set wave_id=:waveId where id='sibling-main-stage'`,
            { waveId: originalWave.id }
          );
        expect(
          await db.activeMainStageDrop('sibling-main-stage', {})
        ).toBeNull();
      }
    );

    it.each([undefined, sibling.id])(
      'rejects an absent or differently bound explicit native target before creating context: %s',
      async (competitionId) => {
        const model: CreateOrUpdateDropModel = {
          drop_id: null,
          wave_id: originalWave.id,
          author_id: 'author',
          author_identity: 'author',
          drop_type: DropType.PARTICIPATORY,
          title: 'Artwork',
          reply_to: null,
          signature: null,
          is_additional_action_promised: false,
          collaborator_ids: ['invitee'],
          referenced_nfts: [],
          mentioned_groups: [],
          mentioned_users: [],
          mentioned_waves: [],
          metadata: [{ data_key: 'memeName', data_value: 'Artwork' }],
          parts: [
            {
              content: 'Artwork',
              quoted_drop: null,
              media: [
                { url: 'https://media.example/art.png', mime_type: 'image/png' }
              ]
            }
          ]
        };
        await expect(
          db.executeNativeQueriesInTransaction((connection) =>
            service.onWrite(
              model,
              'native-stale-chat',
              { connection },
              competitionId
            )
          )
        ).rejects.toThrow(
          competitionId
            ? 'Competition not found'
            : 'Invitations require a Memes Main Stage'
        );
        expect(await db.context('native-stale-chat', {})).toBeNull();
        expect(userNotifier.notifyOfMemeCollaborations).not.toHaveBeenCalled();
      }
    );
  }
);
import { DataSource } from 'typeorm';
import * as Entities from '@/entities/entities';
