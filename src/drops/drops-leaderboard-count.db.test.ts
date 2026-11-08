import 'reflect-metadata';
import {
  legacyCompetitionEntryId,
  legacyCompetitionId
} from '@/competitions/competition-id';
import {
  legacyGetView,
  withLegacyCompetitionGetFacade
} from '@/competitions/legacy-competition-get-facade';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  DROP_CURATIONS_TABLE,
  DROP_NFT_LINKS_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  NFT_LINKS_TABLE
} from '@/constants';
import { PageSortDirection } from '@/api/page-request';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { DropsDb, LeaderboardParams, LeaderboardSort } from './drops.db';

const VOTER = 'lc-voter';
const CURATION = 'lc-curation';

/**
 * The leaderboard count before it read the wave's participant candidates,
 * as MySQL received it inside the API's facade scope: every drop of the wave
 * through the legacy drops view, with the same optional filters. The new
 * statement must return exactly this count.
 */
async function referenceCount(params: LeaderboardParams): Promise<number> {
  const drops = legacyGetView(DROPS_TABLE);
  const hasPrice = params.min_price != null || params.max_price != null;
  const promised = params.is_additional_action_promised != null;
  const sql = `
    ${
      hasPrice
        ? `with drop_prices as (
            select d.id as drop_id, max(nl.price) as drop_price
            from ${drops} d
            left join ${DROP_NFT_LINKS_TABLE} dnl on dnl.drop_id = d.id
            left join ${NFT_LINKS_TABLE} nl
              on nl.canonical_id = dnl.canonical_id
              and nl.price is not null
              and (:price_currency is null or upper(nl.price_currency) = upper(:price_currency))
            where d.wave_id = :wave_id and d.drop_type = '${DropType.PARTICIPATORY}'
            group by d.id)`
        : ''
    }
    select count(*) as cnt from ${drops} d
    ${
      params.unvoted_by_me
        ? `left join ${legacyGetView(DROP_VOTER_STATE_TABLE)} dvs
            on dvs.drop_id = d.id and dvs.wave_id = :wave_id and dvs.voter_id = :voter_id`
        : ''
    }
    ${hasPrice ? 'left join drop_prices dp on dp.drop_id = d.id' : ''}
    where d.wave_id = :wave_id and d.drop_type = '${DropType.PARTICIPATORY}'
    ${
      params.curation_id
        ? `and exists (select 1 from ${DROP_CURATIONS_TABLE} dc
            where dc.drop_id = d.id and dc.curation_id = :curation_id)`
        : ''
    }
    ${promised ? 'and d.is_additional_action_promised = :promised' : ''}
    ${params.unvoted_by_me ? 'and ifnull(dvs.votes, 0) = 0' : ''}
    ${
      hasPrice
        ? `and (:min_price is null or dp.drop_price >= :min_price)
           and (:max_price is null or dp.drop_price <= :max_price)`
        : ''
    }`;
  const row = await sqlExecutor.oneOrNull<{ cnt: number }>(sql, {
    wave_id: params.wave_id,
    voter_id: VOTER,
    curation_id: params.curation_id,
    promised: params.is_additional_action_promised,
    price_currency: params.price_currency,
    min_price: params.min_price,
    max_price: params.max_price
  });
  return Number(row?.cnt ?? 0);
}

const big = aWave(
  { type: WaveType.RANK, voting_period_start: 1, voting_period_end: 9e12 },
  { id: 'lc-big', serial_no: 1, name: 'Big' }
);
const small = aWave(
  { type: WaveType.RANK, voting_period_start: 1, voting_period_end: 9e12 },
  { id: 'lc-small', serial_no: 2, name: 'Small' }
);
const elsewhere = aWave(
  { type: WaveType.RANK, voting_period_start: 1, voting_period_end: 9e12 },
  { id: 'lc-elsewhere', serial_no: 3, name: 'Elsewhere' }
);
const waves = [big, small, elsewhere];

async function insertDrop(
  waveId: string,
  id: string,
  {
    baseType = DropType.COMPETITION,
    entry = 'ACTIVE' as string | null,
    entryWaveId = waveId,
    promised = false
  } = {}
) {
  await sqlExecutor.execute(
    `insert into ${DROPS_TABLE} (id, wave_id, author_id, created_at, updated_at, title, parts_count, reply_to_drop_id, reply_to_part_id, drop_type, signature, hide_link_preview, is_additional_action_promised)
     values (:id, :waveId, 'lc-author', 100, null, null, 1, null, null, :baseType, null, false, :promised)`,
    { id, waveId, baseType, promised }
  );
  if (entry === null) return;
  const competitionId = legacyCompetitionId(entryWaveId);
  await sqlExecutor.execute(
    `insert into ${COMPETITION_ENTRIES_TABLE} (id, competition_id, wave_id, drop_id, submitter_id, status, config_version, submitted_at)
     values (:entryId, :competitionId, :entryWaveId, :id, 'lc-author', :entry, 1, 100)`,
    {
      entryId: legacyCompetitionEntryId(competitionId, id),
      competitionId,
      entryWaveId,
      id,
      entry
    }
  );
}

async function vote(waveId: string, dropId: string, votes: number) {
  const competitionId = legacyCompetitionId(waveId);
  await sqlExecutor.execute(
    `insert into ${COMPETITION_VOTES_TABLE} (id, competition_id, entry_id, voter_profile_id, value, credit_spent, created_at, updated_at)
     values (uuid(), :competitionId, :entryId, :voter, :votes, abs(:votes), 1, 1)`,
    {
      competitionId,
      entryId: legacyCompetitionEntryId(competitionId, dropId),
      voter: VOTER,
      votes
    }
  );
}

async function curate(waveId: string, dropId: string) {
  await sqlExecutor.execute(
    `insert into ${DROP_CURATIONS_TABLE} (drop_id, curation_id, created_at, updated_at, wave_id, curated_by, priority_order)
     values (:dropId, :curation, 1, 1, :waveId, 'lc-curator', null)`,
    { dropId, curation: CURATION, waveId }
  );
}

async function link(dropId: string, canonicalId: string) {
  await sqlExecutor.execute(
    `insert into ${DROP_NFT_LINKS_TABLE} (drop_id, url_in_text, canonical_id, created_at)
     values (:dropId, :canonicalId, :canonicalId, 1)`,
    { dropId, canonicalId }
  );
}

async function seedPrices() {
  for (const [canonicalId, price, currency] of [
    ['lc-nft-eth-3', 3, 'ETH'],
    ['lc-nft-eth-9', 9, 'ETH'],
    ['lc-nft-usd-2', 2, 'USD']
  ] as const)
    await sqlExecutor.execute(
      `insert into ${NFT_LINKS_TABLE} (canonical_id, platform, price, price_currency, last_tried_to_update)
       values (:canonicalId, 'OPENSEA', :price, :currency, 1)`,
      { canonicalId, price, currency }
    );
}

/**
 * Every kind of drop the count must include or leave out, with promises,
 * votes, curations and prices on both sides. Returns how many drops the
 * view calls participatory in the wave.
 */
async function seedWave(waveId: string, actives: number, chats: number) {
  const id = (name: string) => `${waveId}-${name}`;
  for (let i = 0; i < actives; i++)
    await insertDrop(waveId, id(`active-${i}`), { promised: i % 3 === 0 });
  // A base PARTICIPATORY drop with no entry is participatory in the view.
  await insertDrop(waveId, id('legacy'), {
    baseType: DropType.PARTICIPATORY,
    entry: null,
    promised: true
  });
  // Not participatory: withdrawn, disqualified, winners, chat.
  await insertDrop(waveId, id('withdrawn'), {
    baseType: DropType.PARTICIPATORY,
    entry: 'WITHDRAWN',
    promised: true
  });
  await insertDrop(waveId, id('disqualified'), { entry: 'DISQUALIFIED' });
  await insertDrop(waveId, id('winner'), {
    baseType: DropType.PARTICIPATORY,
    entry: 'WINNER',
    promised: true
  });
  await insertDrop(waveId, id('winner-native'), { entry: 'WINNER' });
  for (let i = 0; i < chats; i++)
    await insertDrop(waveId, id(`chat-${i}`), {
      baseType: DropType.CHAT,
      entry: null,
      promised: i % 2 === 0
    });
  // An active entry of this wave's competition whose drop is in another wave.
  await insertDrop(elsewhere.id, id('stray'), {
    baseType: DropType.CHAT,
    entryWaveId: waveId,
    promised: true
  });
  // An active entry whose drop row was deleted.
  await insertDrop(waveId, id('deleted'));
  await sqlExecutor.execute(`delete from ${DROPS_TABLE} where id = :id`, {
    id: id('deleted')
  });

  await vote(waveId, id('active-0'), 4);
  await vote(waveId, id('active-1'), 0);
  await vote(waveId, id('withdrawn'), 2);
  for (const name of ['active-0', 'active-2', 'legacy', 'withdrawn', 'winner'])
    await curate(waveId, id(name));
  for (const [name, nft] of [
    ['active-0', 'lc-nft-eth-3'],
    ['active-1', 'lc-nft-eth-9'],
    ['active-2', 'lc-nft-usd-2'],
    ['legacy', 'lc-nft-eth-3'],
    ['withdrawn', 'lc-nft-eth-3'],
    ['winner', 'lc-nft-eth-3']
  ] as const)
    await link(id(name), nft);
  return actives + 1;
}

const baseParams = (waveId: string): LeaderboardParams => ({
  wave_id: waveId,
  page_size: 20,
  page: 1,
  sort_direction: PageSortDirection.DESC,
  sort: LeaderboardSort.RANK,
  curation_id: null,
  unvoted_by_me: false,
  is_additional_action_promised: null,
  price_currency: null,
  min_price: null,
  max_price: null
});

const filters: [string, Partial<LeaderboardParams>][] = [
  ['no filters', {}],
  ['promised', { is_additional_action_promised: true }],
  ['not promised', { is_additional_action_promised: false }],
  ['unvoted by me', { unvoted_by_me: true }],
  ['curation', { curation_id: CURATION }],
  ['price in ETH', { min_price: 1, max_price: 5, price_currency: 'ETH' }],
  ['price in any currency', { min_price: 1, max_price: 8 }],
  [
    'every filter',
    {
      is_additional_action_promised: true,
      unvoted_by_me: true,
      curation_id: CURATION,
      min_price: 1,
      max_price: 5,
      price_currency: 'eth'
    }
  ]
];

describeWithSeed('DropsDb leaderboard count', withWaves(waves), () => {
  const db = new DropsDb(() => sqlExecutor);
  // Called as the API calls it: inside the legacy facade scope, where the
  // executor rewrites base legacy tables into their views.
  const count = (params: LeaderboardParams) =>
    withLegacyCompetitionGetFacade(() =>
      db.countParticipatoryDrops(params, {}, VOTER)
    );

  beforeEach(async () => {
    for (const wave of waves) await seedNativeOriginalPrimaryFixture(wave);
    await seedPrices();
  });

  it('counts the big and the small wave exactly as the whole-wave view count does, under every filter', async () => {
    const participants = {
      [big.id]: await seedWave(big.id, 12, 40),
      [small.id]: await seedWave(small.id, 2, 3)
    };
    for (const wave of [big, small]) {
      for (const [name, filter] of filters) {
        const params = { ...baseParams(wave.id), ...filter };
        const expected = await referenceCount(params);
        expect({ wave: wave.id, name, count: await count(params) }).toEqual({
          wave: wave.id,
          name,
          count: expected
        });
      }
      // The cases are really there: only active entries and the legacy
      // drop count, and the filters narrow it.
      const unfiltered = await referenceCount(baseParams(wave.id));
      expect(unfiltered).toBe(participants[wave.id]);
      for (const [name, filter] of filters.slice(1))
        expect({
          name,
          narrower:
            (await referenceCount({ ...baseParams(wave.id), ...filter })) <
            unfiltered
        }).toEqual({ name, narrower: true });
    }
  });

  it('follows entries withdrawn and won between two counts', async () => {
    await seedWave(big.id, 12, 40);
    const params = baseParams(big.id);
    const before = await count(params);
    expect(before).toBe(await referenceCount(params));
    for (const [name, status] of [
      ['active-3', 'WITHDRAWN'],
      ['active-4', 'WINNER'],
      ['winner', 'ACTIVE']
    ] as const)
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRIES_TABLE} set status = :status where id = :entryId`,
        {
          status,
          entryId: legacyCompetitionEntryId(
            legacyCompetitionId(big.id),
            `${big.id}-${name}`
          )
        }
      );
    const after = await count(params);
    expect(after).toBe(await referenceCount(params));
    expect(after).toBe(before - 1);
  });
});
