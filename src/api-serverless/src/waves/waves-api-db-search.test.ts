import 'reflect-metadata';
import { withLegacyCompetitionGetFacade } from '@/competitions/legacy-competition-get-facade';
import { WaveEntity } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { SearchWavesParams, WavesApiDb } from '@/api/waves/waves.api.db';

const author = anIdentity(
  {},
  {
    consolidation_key: 'search-author',
    primary_address: 'search-wallet',
    profile_id: 'search-author',
    handle: 'author'
  }
);
const otherAuthor = anIdentity(
  {},
  {
    consolidation_key: 'other-author',
    primary_address: 'other-wallet',
    profile_id: 'other-author',
    handle: 'other'
  }
);
const ctx = { timer: undefined };

function wave(serial: number, name: string, props: Partial<WaveEntity> = {}) {
  return aWave(
    { created_by: author.profile_id!, ...props },
    { id: `search-wave-${serial}`, serial_no: serial, name }
  );
}

async function search(
  name?: string,
  params: Partial<SearchWavesParams> = {},
  groups: string[] = []
) {
  return new WavesApiDb(() => sqlExecutor).searchWaves(
    { name, limit: 50, ...params },
    groups,
    ctx
  );
}

const publicWaves = [
  wave(1, 'Memes-Chat'),
  wave(2, 'ReMemes Chat'),
  wave(3, 'Memes'),
  wave(4, 'Chat'),
  wave(5, "maybe's dive bar"),
  wave(6, '6529 Tech Feedback'),
  wave(7, 'Café — 東京'),
  wave(8, '𐐀rt // Worlds'),
  wave(9, '100%_real\\art'),
  wave(10, '100xxrealxart'),
  wave(11, 'M'),
  wave(12, 'Art ² // Ⅳ'),
  wave(13, 'Memes and Chat'),
  wave(14, 'Memes and Chat'),
  wave(15, 'Many extra memes before chat'),
  wave(16, 'Mementos Chess Chats'),
  wave(17, 'Completely Unrelated')
];

describeWithSeed(
  'WavesApiDb forgiving name search',
  [withIdentities([author, otherAuthor]), withWaves(publicWaves)],
  () => {
    it.each([
      ['memes chat', 1],
      ['memeschat', 1],
      ['Memes Chat', 1],
      ['memes-chat', 1],
      ['meme chat', 1],
      ['chat memes', 1],
      ['  memes  \t chat  ', 1],
      ['memes/chat', 1],
      ['memes—chat', 1],
      ['memes chat memes', 1],
      ['maybes dive bar', 5],
      ['maybe’s dive bar', 5],
      ['tech feedback', 6],
      ['tech-feedback', 6],
      ['café 東京', 7],
      ['𐐀rt worlds', 8],
      ['art ² Ⅳ', 12]
    ])('ranks the remembered name %s first', async (query, serial) => {
      const results = await search(query, { limit: 5 });
      expect(results[0].id).toBe(`search-wave-${serial}`);
    });

    it('requires every term, allowing partial words and any order', async () => {
      expect(
        (await search('chat memes')).map(({ serial_no }) => serial_no)
      ).toEqual([1, 2, 14, 13, 15]);
      expect(
        (await search('meme chat')).map(({ serial_no }) => serial_no)
      ).toContain(16);
      expect(await search('memes nonexistent')).toEqual([]);
    });

    it('ranks raw exact, normalized exact, phrase, then all-term matches before limiting', async () => {
      await sqlExecutor.execute(
        'update waves set name = :name where serial_no = 17',
        { name: 'Memes Chat' }
      );
      expect(
        (await search('Memes Chat', { limit: 3 })).map(
          ({ serial_no }) => serial_no
        )
      ).toEqual([17, 1, 2]);
    });

    it('uses a deterministic order across offset pages', async () => {
      const all = await search('memes chat');
      const pages = [];
      for (let offset = 0; offset < all.length; offset += 2) {
        pages.push(...(await search('memes chat', { limit: 2, offset })));
      }
      expect(pages.map(({ id }) => id)).toEqual(all.map(({ id }) => id));
      expect(await search('memes chat', { offset: all.length })).toEqual([]);
    });

    it.each(['%', '_', '\\', '---', '!?', '   ', '🦄'])(
      'returns no matches for punctuation-only %s',
      async (query) => {
        expect(await search(query)).toEqual([]);
      }
    );

    it.each(['100%_real\\art', '100%', 'real\\art', '%_real'])(
      'treats LIKE metacharacters literally in %s',
      async (query) => {
        expect((await search(query)).map(({ serial_no }) => serial_no)).toEqual(
          [9]
        );
      }
    );

    it('keeps one- and two-character queries available to existing callers', async () => {
      expect((await search('m'))[0].serial_no).toBe(11);
      expect((await search('me')).map(({ serial_no }) => serial_no)).toContain(
        1
      );
    });

    it('keeps unnamed suggestions newest first and respects the serial upper bound', async () => {
      expect(
        (await search(undefined, { limit: 3 })).map(
          ({ serial_no }) => serial_no
        )
      ).toEqual([17, 16, 15]);
      expect(
        (await search('', { limit: 3, serial_no_less_than: 15 })).map(
          ({ serial_no }) => serial_no
        )
      ).toEqual([14, 13, 12]);
      expect(
        (await search('memes chat', { serial_no_less_than: 14 })).map(
          ({ serial_no }) => serial_no
        )
      ).toEqual([1, 2, 13]);
    });

    it('preserves matching and entity decoding through the legacy GET facade', async () => {
      const results = await withLegacyCompetitionGetFacade(() =>
        search('memes chat')
      );
      expect(results[0]).toMatchObject({
        id: 'search-wave-1',
        participation_required_media: [],
        participation_required_metadata: []
      });
      expect(results[0]).not.toHaveProperty('normalized_name');
    });

    it('matches the effective name of an original competition-backed wave', async () => {
      await seedNativeOriginalPrimaryFixture({
        ...publicWaves[0],
        name: 'Original-Competition'
      });
      expect((await search('original competition'))[0]).toMatchObject({
        id: 'search-wave-1',
        name: 'Original-Competition'
      });
      expect((await search('memes chat')).map(({ id }) => id)).not.toContain(
        'search-wave-1'
      );
    });

    it('propagates database failures', async () => {
      const execute = jest
        .spyOn(sqlExecutor, 'execute')
        .mockRejectedValueOnce(new Error('database unavailable'));
      try {
        await expect(search('memes chat')).rejects.toThrow(
          'database unavailable'
        );
      } finally {
        execute.mockRestore();
      }
    });
  }
);

describeWithSeed(
  'WavesApiDb search permissions',
  [
    withIdentities([author, otherAuthor]),
    withWaves([
      wave(1, 'Memes-Chat'),
      wave(2, 'Memes-Chat', { visibility_group_id: 'private' }),
      wave(3, 'Parent', { visibility_group_id: 'parent-private' }),
      wave(4, 'Memes-Chat', { parent_wave_id: 'search-wave-3' }),
      wave(5, 'Memes-Chat', {
        is_direct_message: true,
        visibility_group_id: 'dm'
      }),
      wave(6, 'Memes-Chat', { created_by: otherAuthor.profile_id! }),
      wave(7, 'Memes-Chat', { parent_wave_id: 'missing-parent' }),
      wave(8, 'Memes-Chat', { parent_wave_id: 'search-wave-4' })
    ])
  ],
  () => {
    it('excludes inaccessible waves, hidden-parent children, orphans and nested children', async () => {
      expect(
        (await search('memes chat')).map(({ serial_no }) => serial_no)
      ).toEqual([6, 1]);
    });

    it('includes accessible private waves and children of accessible parents', async () => {
      expect(
        (await search('memes chat', {}, ['private', 'parent-private'])).map(
          ({ serial_no }) => serial_no
        )
      ).toEqual([6, 4, 2, 1]);
    });

    it('retains the caller-specific DM filter and author filter', async () => {
      expect(
        (await search('memes chat', { direct_message: false }, ['dm'])).map(
          ({ serial_no }) => serial_no
        )
      ).toEqual([6, 1]);
      expect(
        (await search('memes chat', { direct_message: true }, ['dm'])).map(
          ({ serial_no }) => serial_no
        )
      ).toEqual([5]);
      expect(
        (await search('memes chat', {}, ['dm'])).map(
          ({ serial_no }) => serial_no
        )
      ).toEqual([6, 5, 1]);
      expect(
        (await search('memes chat', { author: otherAuthor.profile_id! })).map(
          ({ serial_no }) => serial_no
        )
      ).toEqual([6]);
    });

    it('rejects a group filter the viewer is not eligible for', async () => {
      expect(await search('memes chat', { group_id: 'private' })).toEqual([]);
    });
  }
);
