import { nativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import {
  legacyCompetitionId,
  legacyCompetitionEntryId,
  legacyCompetitionDecisionId
} from '@/competitions/competition-id';
import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_DECISIONS_TABLE
} from '@/constants';
import 'reflect-metadata';
import {
  CONTENT_MODERATION_DROP_STATES_TABLE,
  DROP_MEDIA_TABLE,
  DROP_METADATA_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  MEMES_CONTRACT,
  MEMELAB_CONTRACT,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE,
  TRANSACTIONS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE
} from '@/constants';
import { connect, disconnect, getDataSource } from '@/db';
import { setSqlExecutor, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { NewsletterDb } from './newsletter.db';
import { NewsletterCollector } from './newsletter-collector';
import { MAIN_STAGE_WAVE_ID } from './newsletter.config';

const window = {
  start: Date.parse('2026-09-23T00:00:00Z'),
  end: Date.parse('2026-09-24T00:00:00Z'),
  scheduled: true
};
const author = anIdentity(
  {},
  {
    profile_id: 'author',
    handle: 'Ayla',
    primary_address: '0x123',
    consolidation_key: '0x123'
  }
);
const waves = [
  aWave({}, { id: 'public', name: 'Public' }),
  aWave(
    { visibility_group_id: 'group' },
    { id: 'private', name: 'Private secret wave' }
  ),
  aWave(
    { parent_wave_id: 'private' },
    { id: 'private-parent', name: 'Private parent' }
  ),
  aWave(
    { parent_wave_id: 'public', visibility_group_id: 'group' },
    { id: 'private-child', name: 'Private child' }
  ),
  aWave(
    { parent_wave_id: 'public' },
    { id: 'public-child', name: 'Public child' }
  ),
  aWave({ is_direct_message: true }, { id: 'dm', name: 'Direct message' }),
  aWave({ parent_wave_id: 'dm' }, { id: 'dm-child', name: 'DM child' }),
  aWave({ parent_wave_id: 'missing' }, { id: 'orphan', name: 'Orphan' }),
  aWave(
    { parent_wave_id: 'public-child' },
    { id: 'deep', name: 'Unsupported depth' }
  ),
  aWave({}, { id: 'destination', name: 'Newsletter' }),
  aWave({}, { id: MAIN_STAGE_WAVE_ID, name: 'Main Stage' })
];
const drops = waves.map((wave, i) => ({
  id: `drop-${wave.id}`,
  wave_id: wave.id,
  serial_no: i + 1,
  author_id: 'author',
  created_at: window.start,
  parts_count: 1,
  title: `Art ${i}`
}));
const extraDrops = [
  {
    id: 'old-root',
    wave_id: 'public',
    serial_no: 100,
    author_id: 'author',
    created_at: window.start - 1,
    parts_count: 1
  },
  {
    id: 'reply',
    wave_id: 'public',
    serial_no: 101,
    author_id: 'author',
    created_at: window.start + 1,
    parts_count: 1,
    reply_to_drop_id: 'old-root'
  },
  {
    id: 'hidden',
    wave_id: 'public',
    serial_no: 102,
    author_id: 'author',
    created_at: window.start + 2,
    parts_count: 1
  },
  {
    id: 'self',
    wave_id: 'public',
    serial_no: 103,
    author_id: 'publisher',
    created_at: window.start + 3,
    parts_count: 1
  },
  {
    id: 'at-end',
    wave_id: 'public',
    serial_no: 104,
    author_id: 'author',
    created_at: window.end,
    parts_count: 1
  },
  {
    id: 'old-winner',
    wave_id: MAIN_STAGE_WAVE_ID,
    serial_no: 105,
    author_id: 'author',
    created_at: window.start - 86_400_000,
    parts_count: 1,
    title: 'Winning Art'
  }
];
const allDrops = [...drops, ...extraDrops];
const db = new NewsletterDb(() => sqlExecutor);

const newsletterCompetitionId = legacyCompetitionId(MAIN_STAGE_WAVE_ID);
const newsletterWinners = [
  { drop_id: 'old-winner', time: window.start },
  { drop_id: `drop-${MAIN_STAGE_WAVE_ID}`, time: window.end }
];
describeWithSeed(
  'newsletter public database boundary',
  [
    withWaves(waves),
    withIdentities([author]),
    { table: DROPS_TABLE, rows: allDrops },
    {
      table: DROPS_PARTS_TABLE,
      rows: allDrops.map((drop) => ({
        drop_id: drop.id,
        drop_part_id: 1,
        content: `Content ${drop.id}`,
        quoted_drop_id: drop.id === 'reply' ? 'drop-private' : null
      }))
    },
    {
      table: DROP_MEDIA_TABLE,
      rows: allDrops.map((drop) => ({
        drop_id: drop.id,
        drop_part_id: 1,
        url: `https://example.test/${drop.id}.png`,
        mime_type: 'image/png'
      }))
    },
    {
      table: CONTENT_MODERATION_DROP_STATES_TABLE,
      rows: [{ drop_id: 'hidden', status: 'HIDDEN', updated_at: window.start }]
    },
    {
      table: COMPETITIONS_TABLE,
      rows: [
        nativeOriginalPrimaryFixture(
          waves.find((wave) => wave.id === MAIN_STAGE_WAVE_ID)!
        )
      ]
    },
    {
      table: COMPETITION_CAPABILITIES_TABLE,
      rows: [
        {
          competition_id: newsletterCompetitionId,
          wave_id: MAIN_STAGE_WAVE_ID,
          capability: 'MAIN_STAGE',
          assigned_at: 1
        }
      ]
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: newsletterWinners.map((winner) => ({
        id: legacyCompetitionEntryId(newsletterCompetitionId, winner.drop_id),
        competition_id: newsletterCompetitionId,
        wave_id: MAIN_STAGE_WAVE_ID,
        drop_id: winner.drop_id,
        submitter_id: 'author',
        status: 'WINNER',
        config_version: 1,
        submitted_at: winner.time - 1,
        won_at: winner.time,
        decision_id: legacyCompetitionDecisionId(
          newsletterCompetitionId,
          winner.time
        )
      }))
    },
    {
      table: COMPETITION_DECISIONS_TABLE,
      rows: newsletterWinners.map((winner) => ({
        id: legacyCompetitionDecisionId(newsletterCompetitionId, winner.time),
        competition_id: newsletterCompetitionId,
        scheduled_at: winner.time,
        decided_at: winner.time,
        status: 'COMPLETED',
        execution_key: `winner:${winner.time}`,
        created_at: winner.time
      }))
    },
    {
      table: COMPETITION_DECISION_WINNERS_TABLE,
      rows: newsletterWinners.map((winner) => ({
        competition_id: newsletterCompetitionId,
        entry_id: legacyCompetitionEntryId(
          newsletterCompetitionId,
          winner.drop_id
        ),
        decision_id: legacyCompetitionDecisionId(
          newsletterCompetitionId,
          winner.time
        ),
        rank: 1,
        final_rating: 100,
        created_at: winner.time
      }))
    },
    {
      table: DROP_METADATA_TABLE,
      rows: [
        {
          drop_id: 'drop-destination',
          wave_id: 'destination',
          data_key: 'newsletter_edition_id',
          data_value: 'daily:2026-09-23'
        }
      ]
    }
  ],
  () => {
    it('keeps unrevealed submission authors out of all newsletter source reads until that entry wins', async () => {
      const row = nativeOriginalPrimaryFixture(waves[0]);
      const serialized = Object.fromEntries(
        Object.entries({
          ...row,
          type: 'RANK',
          participation_config: {
            ...row.participation_config,
            anonymous_submissions: true
          }
        }).map(([key, value]) => [
          key,
          value !== null && typeof value === 'object'
            ? JSON.stringify(value)
            : value
        ])
      );
      await sqlExecutor.bulkInsert(
        COMPETITIONS_TABLE,
        [serialized],
        Object.keys(serialized)
      );
      const entry = {
        id: 'anonymous-newsletter-entry',
        competition_id: row.id,
        wave_id: waves[0].id,
        drop_id: 'drop-public',
        submitter_id: 'author',
        status: 'ACTIVE',
        config_version: 1,
        submitted_at: window.start
      };
      await sqlExecutor.bulkInsert(
        COMPETITION_ENTRIES_TABLE,
        [entry],
        Object.keys(entry)
      );
      const recent = () =>
        db.recentDrops(
          'public',
          window,
          { createdAt: window.start, serialNo: 0 },
          'publisher',
          {}
        );
      expect((await recent()).map((drop) => drop.id)).not.toContain(
        'drop-public'
      );
      expect(
        await db.contextDrops(
          ['drop-public'],
          window.end,
          'destination',
          'publisher',
          {}
        )
      ).toEqual([]);
      expect(await db.parts(['drop-public'], {})).toEqual([]);
      expect(await db.media(['drop-public'], {})).toEqual([]);
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRIES_TABLE} set status='WINNER', won_at=:wonAt where id=:id`,
        { id: entry.id, wonAt: window.start + 1 }
      );
      expect(
        (await recent()).find((drop) => drop.id === 'drop-public')
      ).toMatchObject({ author_handle: 'Ayla', author_id: 'author' });
      expect(
        await db.contextDrops(
          ['drop-public'],
          window.end,
          'destination',
          'publisher',
          {}
        )
      ).toHaveLength(1);
      expect(await db.parts(['drop-public'], {})).toHaveLength(1);
      expect(await db.media(['drop-public'], {})).toHaveLength(1);
    });

    it('collects epoch timestamps through the Lambda TypeORM executor', async () => {
      const previousExecutor = sqlExecutor;
      try {
        await connect();
        expect(sqlExecutor).not.toBe(previousExecutor);
        expect(getDataSource().isInitialized).toBe(true);
        const [raw] = await sqlExecutor.execute<{ created_at: string }>(
          `select created_at from ${DROPS_TABLE} where id = :id`,
          { id: 'reply' }
        );
        // The Lambda driver returns BIGINT strings; the default test pool casts them.
        expect(raw.created_at).toBe(String(window.start + 1));
        const lambdaDb = new NewsletterDb(() => sqlExecutor);
        expect(
          await lambdaDb.recentDrops(
            'public',
            window,
            { createdAt: window.start, serialNo: 1 },
            'publisher',
            {}
          )
        ).toEqual([
          expect.objectContaining({
            created_at: window.start + 1,
            serial_no: 101
          })
        ]);
        const result = await new NewsletterCollector(lambdaDb).collect(
          window,
          'destination',
          'publisher',
          {}
        );
        expect(
          result.sources.find((source) => source.url.endsWith('serialNo=101'))
        ).toMatchObject({
          time: '2026-09-23T00:00:00.001Z',
          context_only: false,
          discussion_start: 'https://6529.io/waves/public?serialNo=100'
        });
        expect(
          result.sources.find((source) => source.url.endsWith('serialNo=100'))
        ).toMatchObject({
          time: '2026-09-22T23:59:59.999Z',
          context_only: true
        });
        expect(result.winners).toEqual([
          expect.objectContaining({ decision_time: '2026-09-23T00:00:00.000Z' })
        ]);
      } finally {
        try {
          if (getDataSource()?.isInitialized) await disconnect();
        } finally {
          setSqlExecutor(previousExecutor);
        }
      }
    });

    it('discovers only anonymous public waves, including eligible subwaves', async () => {
      expect(await db.activeWaves(window, 'destination', {})).toEqual(
        [MAIN_STAGE_WAVE_ID, 'public', 'public-child'].sort((a, b) =>
          a.localeCompare(b)
        )
      );
    });

    it('enforces public visibility separately for drops, context, text and media', async () => {
      const restricted = [
        'private',
        'private-parent',
        'private-child',
        'dm',
        'dm-child',
        'orphan',
        'deep'
      ];
      for (const wave of restricted) {
        expect(
          await db.recentDrops(
            wave,
            window,
            { createdAt: window.start, serialNo: 0 },
            'publisher',
            {}
          )
        ).toEqual([]);
      }
      const restrictedIds = [...restricted.map((id) => `drop-${id}`), 'hidden'];
      expect(
        await db.contextDrops(
          restrictedIds,
          window.end,
          'destination',
          'publisher',
          {}
        )
      ).toEqual([]);
      expect(await db.parts(restrictedIds, {})).toEqual([]);
      expect(await db.media(restrictedIds, {})).toEqual([]);
      expect(
        (
          await db.recentDrops(
            'public',
            window,
            { createdAt: window.start, serialNo: 0 },
            'publisher',
            {}
          )
        ).map((drop) => drop.id)
      ).toEqual(['drop-public', 'reply']);
      expect(
        (
          await db.recentDrops(
            'public',
            window,
            { createdAt: window.start, serialNo: 1 },
            'publisher',
            {}
          )
        ).map((drop) => drop.id)
      ).toEqual(['reply']);
    });

    it('collects an older public root and winner without following a private quote', async () => {
      const result = await new NewsletterCollector(db).collect(
        window,
        'destination',
        'publisher',
        {}
      );
      const reply = result.sources.find((source) =>
        source.url.endsWith('serialNo=101')
      )!;
      expect(reply.discussion_start).toBe(
        'https://6529.io/waves/public?serialNo=100'
      );
      expect(reply.quoted_messages).toEqual([]);
      expect(reply.author_url).toBe('https://6529.io/Ayla');
      expect(
        result.sources.find((source) => source.url.endsWith('serialNo=100'))
          ?.context_only
      ).toBe(true);
      expect(result.winners).toEqual([
        expect.objectContaining({
          author: 'Ayla',
          title: 'Winning Art',
          url: `https://6529.io/waves/${MAIN_STAGE_WAVE_ID}?serialNo=105`
        })
      ]);
      const serialized = JSON.stringify(result);
      for (const text of [
        'Private secret wave',
        'drop-private',
        'drop-dm',
        'Content hidden',
        'Content self',
        'Content at-end',
        'Content drop-destination'
      ])
        expect(serialized).not.toContain(text);
    });

    it('scopes the scheduled publication marker to the publisher and destination', async () => {
      expect(
        await db.publishedEdition(
          'daily:2026-09-23',
          'destination',
          'author',
          {}
        )
      ).toBe('drop-destination');
      expect(
        await db.publishedEdition(
          'daily:2026-09-23',
          'destination',
          'publisher',
          {}
        )
      ).toBeNull();
      expect(
        await db.publishedEdition('daily:2026-09-23', 'public', 'author', {})
      ).toBeNull();
    });
  }
);

const nft = {
  id: 552,
  contract: MEMES_CONTRACT,
  created_at: new Date(window.start),
  mint_date: new Date(window.start - 86_400_000),
  mint_price: 0.06529,
  supply: 100,
  edition_size_floor: 100,
  name: 'The First Believer',
  collection: 'The Memes',
  token_type: 'ERC1155',
  description: '',
  artist: 'Ayla',
  artist_seize_handle: 'Ayla',
  floor_price: 0,
  market_cap: 0,
  total_volume_last_24_hours: 0,
  total_volume_last_7_days: 0,
  total_volume_last_1_month: 0,
  total_volume: 0,
  highest_offer: 0,
  hodl_rate: 0,
  boosted_tdh: 0,
  tdh: 0,
  tdh__raw: 0,
  tdh_rank: 0
};
const transactions = [
  window.start - 1000,
  window.start,
  window.end - 1000,
  window.end
].map((date, i) => ({
  created_at: new Date(date),
  transaction_date: new Date(date),
  transaction: `tx-${i}`,
  block: i,
  from_address: '0x0000000000000000000000000000000000000000',
  to_address: '0x123',
  contract: MEMES_CONTRACT,
  token_id: 552,
  token_count: 2,
  value: 0,
  primary_proceeds: 0,
  royalties: 0,
  gas_gwei: 0,
  gas_price: 0,
  gas_price_gwei: 0,
  gas: 0
}));

describeWithSeed(
  'newsletter indexed mint activity',
  [
    { table: NFTS_TABLE, rows: [nft] },
    {
      table: TRANSACTIONS_TABLE,
      rows: [
        ...transactions,
        {
          ...transactions[1],
          transaction: 'secondary-sale',
          from_address: '0x456'
        }
      ]
    }
  ],
  () => {
    it('selects actual mints within the half-open window, preserving the earlier launch date', async () => {
      const mints = await db.mints(window, {});
      expect(mints).toHaveLength(1);
      expect(Number(mints[0].minted_count)).toBe(4);
      expect(mints[0].first_mint_in_window).toEqual(
        new Date(window.start).toISOString()
      );
      expect(mints[0].mint_date).toEqual(nft.mint_date.toISOString());
      const material = await new NewsletterCollector(db).collect(
        window,
        'destination',
        'publisher',
        {}
      );
      expect(material.mints[0]).toEqual(
        expect.objectContaining({
          card: 552,
          url: 'https://6529.io/the-memes/552',
          artists: [{ handle: 'Ayla', url: 'https://6529.io/Ayla' }]
        })
      );
    });
  }
);

const {
  edition_size_floor,
  hodl_rate,
  boosted_tdh,
  tdh,
  tdh__raw,
  tdh_rank,
  ...labBase
} = nft;
describeWithSeed(
  'newsletter Meme Lab mints',
  [
    {
      table: NFTS_MEME_LAB_TABLE,
      rows: [{ ...labBase, contract: MEMELAB_CONTRACT, meme_references: [] }]
    },
    {
      table: TRANSACTIONS_TABLE,
      rows: [{ ...transactions[1], contract: MEMELAB_CONTRACT }]
    }
  ],
  () => {
    it('uses the correct collection page even when card numbers overlap', async () => {
      const result = await new NewsletterCollector(db).collect(
        window,
        'destination',
        'publisher',
        {}
      );
      expect(result.mints).toEqual([
        expect.objectContaining({
          collection: 'Meme Lab',
          card: 552,
          url: 'https://6529.io/meme-lab/552'
        })
      ]);
    });
  }
);
