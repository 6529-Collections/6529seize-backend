import 'reflect-metadata';
import { AuthenticationContext } from '@/auth-context';
import { legacyCompetitionId } from '@/competitions/competition-id';
import {
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_TABLE,
  MEME_COLLABORATION_INVITATIONS_TABLE,
  MEME_COLLABORATIONS_TABLE,
  MINT_LOG_CARD_HEADS_TABLE,
  MINT_LOG_HEAD_TABLE,
  REMEMES_TABLE,
  REMEMES_UPLOADS,
  ROYALTIES_UPLOADS_TABLE
} from '@/constants';
import { addRememe } from '@/db-api';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import { RememeSource } from '@/entities/IRememe';
import { WaveType } from '@/entities/IWave';
import { env } from '@/env';
import { rememeAddSpec } from '@/api/rememes/rememe-add-log';
import rememesRoutes from '@/api/rememes/rememes.routes';
import royaltiesRoutes from '@/api/royalties/royalties.routes';
import { getMemeCollaborationState } from '@/api/meme-collaborations/meme-collaborations.handlers';
import { fetchRememesUploads } from '@/db-api';
import { Router } from 'express';
import { MemeCollaborationsDb } from '@/meme-collaborations/meme-collaborations.db';
import {
  collaborationArtworkDetails,
  collaborationArtworkHash,
  MemeCollaborationsService
} from '@/meme-collaborations/meme-collaborations.service';
import { userNotifier } from '@/notifications/user.notifier';
import { sqlExecutor } from '@/sql-executor';
import { nativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { describeWithSeed } from '@/tests/_setup/seed';
import { allOk, apiAnswers } from './mint-log-api-answers.test-utils';
import { mintStateReader } from './mint-log-capture';
import { differingParts } from './mint-log-diff';
import { MintContentPort, runMintGenesis } from './mint-log-genesis';
import { mintCard } from './mint-log-parts';
import type { MintRecordLogEntry, MintRecordLogPort } from './mint-log-ports';
import { logPublicationReceipt } from './mint-log-receipts';
import { MintLogRebuilder } from './mint-log-rebuild';
import { entrySha256, MintLogRecorder } from './mint-log-recorder';
import type { MintCardRef, MintLogEntryBody } from './mint-log.types';

const W = (n: number) => `0x${String(n).padStart(40, '0')}`;
const wave = aWave(
  { type: WaveType.RANK, participation_terms: 'Terms' },
  { id: 'wave', name: 'Main Stage' }
);
const competitionId = legacyCompetitionId(wave.id);
const artwork: CreateOrUpdateDropModel = {
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
const artworkHash = collaborationArtworkHash(artwork);
const termsVersion = 'b'.repeat(64);
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
const invites = [invitation('B', 1), invitation('C', 2)];
const auth = (profile: string) =>
  new AuthenticationContext({
    authenticatedProfileId: profile,
    authenticatedWallet: W(profile.charCodeAt(0)),
    roleProfileId: null,
    activeProxyActions: []
  });
const reply = (action: 'ACCEPT' | 'DECLINE') => ({
  action,
  artwork_hash: artworkHash,
  terms_version: termsVersion
});

// Rememe contracts in mixed case, as the provider returns them.
const FILE_CONTRACT = '0x00000000000000000000000000000000000000Aa';
const ADDED_CONTRACT = '0x00000000000000000000000000000000000000Bb';
const fileRememe = {
  contract: FILE_CONTRACT,
  id: '1',
  deployer: W(7),
  token_uri: 'ipfs://token/1',
  token_type: 'ERC721',
  image: 'ipfs://image/1',
  animation: '',
  meme_references: JSON.stringify([1]),
  metadata: JSON.stringify({ name: 'One' }),
  contract_opensea_data: JSON.stringify({}),
  media: JSON.stringify({}),
  source: RememeSource.FILE,
  added_by: null
};
const addBody = (contract: string, tokenId: string) => ({
  contract: {
    address: contract,
    contractDeployer: W(8),
    openSeaMetadata: { collectionName: 'Rememes' },
    tokenType: 'ERC721'
  },
  nfts: [
    {
      tokenId,
      tokenType: 'ERC721',
      tokenUri: `ipfs://token/${tokenId}`,
      image: { originalUrl: `ipfs://image/${tokenId}` },
      raw: {
        metadata: { name: `Token ${tokenId}`, image: `ipfs://${tokenId}` }
      }
    }
  ],
  references: [1, 2]
});

function memoryContent(): MintContentPort {
  const files = new Map<string, Buffer>();
  return {
    put: async (name, bytes) => {
      files.set(`cid-${name}`, bytes);
      return `cid-${name}`;
    },
    get: async (cid) => {
      const bytes = files.get(cid);
      if (!bytes) throw new Error(`No file ${cid}`);
      return bytes;
    }
  };
}

function capture(card: MintCardRef) {
  return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    mintStateReader.capture(card, connection)
  );
}

async function empty(tables: readonly string[]): Promise<void> {
  for (const table of tables) {
    await sqlExecutor.execute(`delete from ${table}`);
  }
}

/**
 * GET /drops/:drop_id/collaborations through its handler, as anyone or as a
 * signed-in wallet (?viewer=), since the state shows invitations only to the
 * author and the invitees.
 */
const collaborationState = Router().get(
  '/drops/:drop_id/collaborations',
  async (req, res) => {
    if (typeof req.query.viewer === 'string') {
      (req as { user?: unknown }).user = { wallet: req.query.viewer };
    }
    try {
      res.json(await getMemeCollaborationState(req as any));
    } catch (error) {
      res
        .status((error as { status?: number }).status ?? 500)
        .json({ error: String(error) });
    }
  }
);

/**
 * GET /rememes_uploads, which app.ts serves inline: the same reader and the
 * same shaping.
 */
const rememesUploads = Router().get('/rememes_uploads', async (_req, res) => {
  const result = await fetchRememesUploads(50, 1);
  result.data.forEach((row: any) => {
    row.date = row.created_at;
    delete row.created_at;
  });
  res.json(result);
});

const MATCH = {
  undeclared: [],
  merkle_raw: [],
  replay: 'match',
  replay_mismatches: []
};

describeWithSeed(
  'mint log collaboration and rememes chains on MySQL',
  [
    withProfiles(
      ['A', 'B', 'C', 'D', 'E'].map((id, index) =>
        aProfile({
          external_id: id,
          handle: `Artist${id}`,
          primary_wallet: W(index + 1)
        })
      )
    ),
    withWaves([wave]),
    { table: COMPETITIONS_TABLE, rows: [nativeOriginalPrimaryFixture(wave)] },
    {
      table: COMPETITION_CAPABILITIES_TABLE,
      rows: [
        {
          capability: 'MAIN_STAGE',
          competition_id: competitionId,
          wave_id: 'wave',
          assigned_at: 0
        }
      ]
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: [
        {
          id: 'main-stage-entry',
          competition_id: competitionId,
          wave_id: 'wave',
          drop_id: 'drop',
          submitter_id: 'A',
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 1
        }
      ]
    },
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
    {
      table: MEME_COLLABORATIONS_TABLE,
      rows: [
        {
          drop_id: 'drop',
          author_id: 'A',
          author_handle: 'ArtistA',
          wave_id: 'wave',
          artwork_hash: artworkHash,
          artwork: collaborationArtworkDetails(artwork),
          base_artist: 'Artist A',
          terms: 'Terms',
          terms_version: termsVersion,
          closed_at: null,
          credit: null
        }
      ]
    },
    { table: MEME_COLLABORATION_INVITATIONS_TABLE, rows: invites },
    { table: REMEMES_TABLE, rows: [fileRememe] }
  ],
  () => {
    const entries: MintLogEntryBody[] = [];
    const log: MintRecordLogPort = {
      append: async (queued: readonly MintRecordLogEntry[]) => {
        for (const entry of queued) {
          if (entry.t === 'entry') {
            entries.push(entry.body as unknown as MintLogEntryBody);
          }
        }
      }
    };
    const recorder = new MintLogRecorder(
      {
        isMintLogShadowEnabled: () => true,
        isMintLogPrimaryEnabled: () => false,
        isMintLogReplayCheckEnabled: () => true
      },
      () => ({ records: null, log })
    );
    const db = new MemeCollaborationsDb(() => sqlExecutor);
    const service = new MemeCollaborationsService(db, async () => recorder);
    const originalGetStringOrNull = env.getStringOrNull.bind(env);

    beforeEach(() => {
      entries.length = 0;
      jest
        .spyOn(env, 'getStringOrNull')
        .mockImplementation((key) =>
          key === 'MAIN_STAGE_WAVE_ID' ? 'wave' : originalGetStringOrNull(key)
        );
      jest
        .spyOn(userNotifier, 'notifyOfMemeCollaboration')
        .mockResolvedValue([42]);
      jest
        .spyOn(userNotifier, 'notifyOfMemeCollaborations')
        .mockImplementation(async (notifications) =>
          notifications.map((_notification, index) => 43 + index)
        );
    });
    afterEach(() => jest.restoreAllMocks());

    it('logs each artwork on its own head and rebuilds the collaborations', async () => {
      const content = memoryContent();
      await runMintGenesis({ content, log, chains: ['collab'] });
      await service.respond(
        'drop',
        invites[0].id,
        { ...reply('ACCEPT'), artist_name: 'Artist B Name' },
        auth('B'),
        {}
      );
      await service.respond(
        'drop',
        invites[1].id,
        reply('DECLINE'),
        auth('C'),
        {}
      );
      await service.inviteExisting('drop', ['E'], auth('A'), {});
      await db.executeNativeQueriesInTransaction((connection) =>
        service.freezeForMint('drop', { connection })
      );
      // A submission after the genesis, edited, then deleted.
      await db.executeNativeQueriesInTransaction((connection) =>
        service.onWrite({ ...artwork, collaborator_ids: ['D'] }, 'drop2', {
          connection,
          authenticationContext: auth('A')
        })
      );
      await db.executeNativeQueriesInTransaction((connection) =>
        service.onWrite(
          {
            ...artwork,
            drop_id: 'drop2',
            metadata: artwork.metadata.map((item) =>
              item.data_key === 'title'
                ? { ...item, data_value: 'Artwork, second version' }
                : item
            )
          },
          'drop2',
          { connection, authenticationContext: auth('A') }
        )
      );
      await db.executeNativeQueriesInTransaction((connection) =>
        service.closeDeleted('drop2', { connection })
      );

      expect(
        entries.map((entry) => [
          entry.kind,
          entry.chain,
          entry.card?.key,
          entry.seq
        ])
      ).toEqual([
        ['mint.genesis', 'collab', 'drop', 0],
        ['collab.respond', 'collab', 'drop', 1],
        ['collab.respond', 'collab', 'drop', 2],
        ['collab.invite', 'collab', 'drop', 3],
        ['collab.freeze', 'collab', 'drop', 4],
        ['collab.invite', 'collab', 'drop2', 0],
        ['collab.artwork', 'collab', 'drop2', 1],
        ['collab.close', 'collab', 'drop2', 2]
      ]);
      for (const entry of entries.slice(1)) {
        expect({ kind: entry.kind, checks: entry.checks }).toEqual({
          kind: entry.kind,
          checks: MATCH
        });
      }
      expect(entries[1]).toMatchObject({
        actor: { type: 'user', wallet: W(66), authority: 'invitee' },
        intent: {
          route: 'POST /drops/:drop_id/collaborations/:invitation_id/response',
          params: { drop_id: 'drop', invitation_id: invites[0].id }
        }
      });
      expect(entries[5]).toMatchObject({
        actor: { type: 'user', wallet: W(65), authority: 'drop author' },
        intent: { route: 'drop.write', body: { collaborator_ids: ['D'] } }
      });
      expect(entries[6].effects.collaboration?.upsert).toHaveLength(1);
      expect(entries[6].effects.collaboration_invitations).toBeUndefined();

      const cards = ['drop', 'drop2'].map((key) => mintCard('collab', 0, key));
      const live = await Promise.all(cards.map(capture));
      const endpoints = () =>
        apiAnswers(
          [['', collaborationState]],
          [
            '/drops/drop/collaborations',
            `/drops/drop/collaborations?viewer=${W(1)}`,
            `/drops/drop/collaborations?viewer=${W(5)}`
          ]
        );
      const answers = await endpoints();
      expect(allOk(answers)).toEqual([]);
      expect(live[0].collaboration[0]).toMatchObject({ drop_id: 'drop' });
      expect(live[1].collaboration_invitations).toHaveLength(1);
      expect(
        await sqlExecutor.execute(
          `select card_key, seq from ${MINT_LOG_CARD_HEADS_TABLE} order by card_key`
        )
      ).toEqual([
        { card_key: 'drop', seq: 4 },
        { card_key: 'drop2', seq: 2 }
      ]);

      await empty([
        MEME_COLLABORATIONS_TABLE,
        MEME_COLLABORATION_INVITATIONS_TABLE,
        MINT_LOG_CARD_HEADS_TABLE
      ]);
      const result = await new MintLogRebuilder(content).rebuild(entries);
      expect(result.heads).toEqual({
        'collab:drop': { seq: 4, hash: entrySha256(entries[4]) },
        'collab:drop2': { seq: 2, hash: entrySha256(entries[7]) }
      });
      const rebuilt = await Promise.all(cards.map(capture));
      expect(differingParts(rebuilt[0], live[0])).toEqual([]);
      expect(differingParts(rebuilt[1], live[1])).toEqual([]);
      expect(await endpoints()).toEqual(answers);
      expect(
        await sqlExecutor.execute(
          `select card_key, seq from ${MINT_LOG_CARD_HEADS_TABLE} order by card_key`
        )
      ).toEqual([
        { card_key: 'drop', seq: 4 },
        { card_key: 'drop2', seq: 2 }
      ]);
    });

    it('refuses a collaboration entry out of order', async () => {
      const content = memoryContent();
      await runMintGenesis({ content, log, chains: ['collab'] });
      await service.respond(
        'drop',
        invites[1].id,
        reply('DECLINE'),
        auth('C'),
        {}
      );
      await empty([MINT_LOG_CARD_HEADS_TABLE]);
      await expect(
        new MintLogRebuilder(content).rebuild([entries[1], entries[0]])
      ).rejects.toThrow('Mint log gap in collab:drop');
    });

    it('logs rememe adds and published files on the rememes chain and rebuilds them', async () => {
      const content = memoryContent();
      await runMintGenesis({ content, log, chains: ['rememes'] });
      for (const [contract, tokenId] of [
        [FILE_CONTRACT, '2'],
        [ADDED_CONTRACT, '5']
      ]) {
        await recorder.write(rememeAddSpec({ address: W(3) }, contract), () =>
          addRememe(W(3), addBody(contract, tokenId))
        );
      }
      await logPublicationReceipt(
        REMEMES_UPLOADS,
        'rememes',
        { url: 'https://arweave.net/rememes-1' },
        async () => {
          await sqlExecutor.execute(
            `insert into ${REMEMES_UPLOADS} (url) values ('https://arweave.net/rememes-1')`
          );
        },
        recorder
      );
      await logPublicationReceipt(
        ROYALTIES_UPLOADS_TABLE,
        'royalties',
        { date: '2026-11-21', url: 'https://arweave.net/royalties-1' },
        async () => {
          await sqlExecutor.execute(
            `insert into ${ROYALTIES_UPLOADS_TABLE} (date, url) values ('2026-11-21', 'https://arweave.net/royalties-1')`
          );
        },
        recorder
      );

      expect(
        entries.map((entry) => [
          entry.kind,
          entry.chain,
          entry.card?.key ?? null,
          entry.seq
        ])
      ).toEqual([
        ['mint.genesis', 'rememes', null, 0],
        ['rememe.add', 'rememes', FILE_CONTRACT.toLowerCase(), 1],
        ['rememe.add', 'rememes', ADDED_CONTRACT.toLowerCase(), 2],
        ['publication.receipt', 'rememes', REMEMES_UPLOADS, 3],
        ['publication.receipt', 'rememes', ROYALTIES_UPLOADS_TABLE, 4]
      ]);
      // The genesis lists the file rememe's contract and both upload lists,
      // in card order.
      expect(
        (entries[0].inputs.cards as { key: string }[]).map((card) => card.key)
      ).toEqual([
        FILE_CONTRACT.toLowerCase(),
        ROYALTIES_UPLOADS_TABLE,
        REMEMES_UPLOADS
      ]);
      for (const entry of entries.slice(1)) {
        expect({ kind: entry.kind, checks: entry.checks }).toEqual({
          kind: entry.kind,
          checks: MATCH
        });
      }
      expect(entries[1]).toMatchObject({
        actor: { type: 'user', wallet: W(3), authority: 'wallet signature' },
        record_id: null,
        intent: { route: 'POST /rememes/add', body: { address: W(3) } }
      });
      expect(entries[1].effects.rememes?.upsert).toEqual([
        expect.objectContaining({
          contract: FILE_CONTRACT,
          id: '2',
          source: RememeSource.SEIZE,
          added_by: W(3)
        })
      ]);

      const cards = [
        mintCard('rememes', 0, FILE_CONTRACT.toLowerCase()),
        mintCard('rememes', 0, ADDED_CONTRACT.toLowerCase()),
        mintCard('uploads', 0, REMEMES_UPLOADS),
        mintCard('uploads', 0, ROYALTIES_UPLOADS_TABLE)
      ];
      const live = await Promise.all(cards.map(capture));
      expect(live[0].rememes.map((row) => row.id)).toEqual(['1', '2']);
      const endpoints = () =>
        apiAnswers(
          [
            ['/rememes', rememesRoutes],
            ['/royalties', royaltiesRoutes],
            ['', rememesUploads]
          ],
          [
            // Without a sort the list comes in random order.
            '/rememes?sort=created_at&sort_direction=asc',
            `/rememes?contract=${ADDED_CONTRACT}&sort=created_at&sort_direction=asc`,
            '/rememes_uploads',
            '/royalties/uploads'
          ],
          // Set by the database when the rebuild inserts the row.
          ['updated_at']
        );
      const answers = await endpoints();
      expect(allOk(answers)).toEqual([]);

      await empty([
        REMEMES_TABLE,
        REMEMES_UPLOADS,
        ROYALTIES_UPLOADS_TABLE,
        MINT_LOG_HEAD_TABLE
      ]);
      const result = await new MintLogRebuilder(content).rebuild(entries);
      expect(result.heads).toEqual({
        rememes: { seq: 4, hash: entrySha256(entries[4]) }
      });
      const rebuilt = await Promise.all(cards.map(capture));
      cards.forEach((card, index) =>
        expect({
          card: card.key,
          parts: differingParts(rebuilt[index], live[index])
        }).toEqual({ card: card.key, parts: [] })
      );
      expect(await endpoints()).toEqual(answers);
    });
  }
);
