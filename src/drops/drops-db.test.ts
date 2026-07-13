import {
  ACTIVITY_EVENTS_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  IDENTITIES_TABLE,
  TDH_NFT_TABLE,
  WAVE_DROPPER_METRICS_TABLE,
  WAVE_METRICS_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { PageSortDirection } from '@/api/page-request';
import { DbPoolName } from '@/db-query.options';
import { DropType } from '@/entities/IDrop';
import { DropsDb, LeaderboardSort } from './drops.db';

describe('DropsDb', () => {
  it('groups active and winning submissions by author and wave', async () => {
    const connection = {};
    const execute = jest.fn().mockResolvedValue([
      {
        wave_id: 'wave-1',
        author_id: 'author-1',
        is_participant: 1,
        is_winner: 1
      },
      {
        wave_id: 'wave-2',
        author_id: 'author-2',
        is_participant: 1,
        is_winner: 0
      }
    ]);
    const repo = new DropsDb(
      () =>
        ({
          execute
        }) as any
    );

    const result = await repo.findAuthorWaveParticipationByDropContexts(
      [
        { wave_id: 'wave-1', author_id: 'author-1' },
        { wave_id: 'wave-1', author_id: 'author-1' },
        { wave_id: 'wave-2', author_id: 'author-2' }
      ],
      {
        connection: { connection } as any,
        timer: undefined
      }
    );

    expect(result).toEqual({
      'wave-1': {
        'author-1': {
          is_participant: true,
          is_winner: true
        }
      },
      'wave-2': {
        'author-2': {
          is_participant: true,
          is_winner: false
        }
      }
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params, options] = execute.mock.calls[0];
    expect(sql).toContain(
      'select :waveId0 as wave_id, :authorId0 as author_id'
    );
    expect(sql).toContain(
      'select :waveId1 as wave_id, :authorId1 as author_id'
    );
    expect(sql).toContain("participant.drop_type = 'PARTICIPATORY'");
    expect(sql).toContain("winner.drop_type = 'WINNER'");
    expect(sql).toContain('exists(');
    expect(params).toEqual({
      waveId0: 'wave-1',
      authorId0: 'author-1',
      waveId1: 'wave-2',
      authorId1: 'author-2'
    });
    expect(options).toEqual({ wrappedConnection: { connection } });
  });

  it('pages full competition drops for one author in one wave', async () => {
    const connection = {};
    const drops = [{ id: 'entry-1' }, { id: 'entry-2' }];
    const execute = jest.fn().mockResolvedValue(drops);
    const repo = new DropsDb(
      () =>
        ({
          execute
        }) as any
    );

    const result = await repo.findWaveCompetitionDropsByAuthor(
      {
        wave_id: 'wave-1',
        author_id: 'author-1',
        drop_type: DropType.PARTICIPATORY,
        limit: 51,
        offset: 50
      },
      {
        connection: { connection } as any,
        timer: undefined
      }
    );

    expect(result).toBe(drops);
    const [sql, params, options] = execute.mock.calls[0];
    expect(sql).toContain('wave_id = :wave_id');
    expect(sql).toContain('author_id = :author_id');
    expect(sql).toContain('drop_type = :drop_type');
    expect(sql).toContain('limit :limit offset :offset');
    expect(params).toEqual({
      wave_id: 'wave-1',
      author_id: 'author-1',
      drop_type: DropType.PARTICIPATORY,
      limit: 51,
      offset: 50
    });
    expect(options).toEqual({ wrappedConnection: { connection } });
  });

  it('applies a bounded metrics delta when a drop is deleted', async () => {
    const connection = {};
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new DropsDb(
      () =>
        ({
          execute
        }) as any
    );

    await repo.applyDeletedDropMetricsDelta(
      {
        wave_id: 'wave-1',
        author_id: 'author-1',
        drop_type: DropType.PARTICIPATORY
      },
      {
        connection: { connection } as any,
        timer: undefined
      }
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0]).toContain(
      `update ${WAVE_METRICS_TABLE} wm`
    );
    expect(execute.mock.calls[0]?.[0]).toContain(
      'wm.participatory_drops_count - :participatoryDropsDelta'
    );
    expect(execute.mock.calls[0]?.[0]).toContain(`from ${DROPS_TABLE} d`);
    expect(execute.mock.calls[0]?.[1]).toEqual({
      waveId: 'wave-1',
      chatDropsDelta: 0,
      participatoryDropsDelta: 1
    });
    expect(execute.mock.calls[0]?.[2]).toEqual({
      wrappedConnection: { connection }
    });
    expect(execute.mock.calls[1]?.[0]).toContain(
      `update ${WAVE_DROPPER_METRICS_TABLE} wdm`
    );
    expect(execute.mock.calls[1]?.[1]).toEqual({
      waveId: 'wave-1',
      dropperId: 'author-1',
      chatDropsDelta: 0,
      participatoryDropsDelta: 1
    });
    expect(execute.mock.calls[1]?.[2]).toEqual({
      wrappedConnection: { connection }
    });
  });

  it('can force full drop metrics resyncs onto the write pool', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new DropsDb(
      () =>
        ({
          execute
        }) as any
    );

    await repo.resyncDropCountsForWaves(
      ['wave-1'],
      { timer: undefined },
      { forcePool: DbPoolName.WRITE }
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[2]).toEqual({
      wrappedConnection: undefined,
      forcePool: DbPoolName.WRITE
    });
    expect(execute.mock.calls[1]?.[2]).toEqual({
      wrappedConnection: undefined,
      forcePool: DbPoolName.WRITE
    });
  });

  it('deletes activity feed items by indexed drop columns', async () => {
    const connection = {};
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new DropsDb(
      () =>
        ({
          execute
        }) as any
    );

    await repo.deleteDropFeedItems('drop-1', {
      connection: { connection } as any,
      timer: undefined
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params, options] = execute.mock.calls[0];
    expect(sql).toBe(
      `delete from ${ACTIVITY_EVENTS_TABLE} where drop_id = :dropId or (target_type = 'DROP' and target_id = :dropId)`
    );
    expect(sql.toLowerCase()).not.toContain('like');
    expect(params).toEqual({ dropId: 'drop-1' });
    expect(options).toEqual({ wrappedConnection: { connection } });
  });

  it('uses wave voting credit nft rows when finding CARD_SET_TDH overvoters', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new DropsDb(
      () =>
        ({
          execute
        }) as any
    );

    const result =
      await repo.findTdhBasedSubmissionDropOvervotersWithOvervoteAmounts({
        timer: undefined
      });

    expect(result).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(4);
    const [sql] = execute.mock.calls[3];
    expect(sql).toContain(`from ${DROP_VOTER_STATE_TABLE}`);
    expect(sql).toContain(`join ${DROPS_TABLE}`);
    expect(sql).toContain(`from ${IDENTITIES_TABLE}`);
    expect(sql).toContain(`join ${WAVES_TABLE} w`);
    expect(sql).toContain(`voting_credit_scope`);
    expect(sql).toContain(`join ${WAVE_VOTING_CREDIT_NFTS_TABLE} wvcn`);
    expect(sql).toContain(`left join ${TDH_NFT_TABLE} tn`);
    expect(sql).toContain(`CARD_SET_TDH`);
    expect(sql).toContain(`card_set_voter_waves as`);
    expect(sql).toContain(`select distinct voter_id, wave_id`);
    expect(sql).toContain(`from card_set_voter_waves v`);
  });

  it('filters realtime leaderboard drops by additional action promise flag', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new DropsDb(
      () =>
        ({
          execute
        }) as any
    );

    await repo.findRealtimeLeaderboardDrops(
      {
        wave_id: 'wave-1',
        limit: 10,
        offset: 0,
        sort_order: PageSortDirection.ASC,
        sort_by_realtime_vote: false,
        unvoted_by_me: false,
        voter_id: null,
        curation_id: null,
        price_currency: null,
        min_price: null,
        max_price: null,
        is_additional_action_promised: false
      },
      { timer: undefined }
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain(
      'd.is_additional_action_promised = :is_additional_action_promised'
    );
    expect(params).toMatchObject({
      is_additional_action_promised: false
    });
  });

  it('orders realtime leaderboard vote sorting by vote direction', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new DropsDb(
      () =>
        ({
          execute
        }) as any
    );

    await repo.findRealtimeLeaderboardDrops(
      {
        wave_id: 'wave-1',
        limit: 10,
        offset: 0,
        sort_order: PageSortDirection.DESC,
        sort_by_realtime_vote: true,
        unvoted_by_me: false,
        voter_id: null,
        curation_id: null,
        price_currency: null,
        min_price: null,
        max_price: null,
        is_additional_action_promised: null
      },
      { timer: undefined }
    );

    const [sql] = execute.mock.calls[0];
    expect(sql).toMatch(
      /order by\s+r\.vote DESC,\s+r\.timestamp ASC,\s+r\.drop_id ASC\s+limit/
    );
  });

  it('keeps rank sorting ordered by rank direction', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new DropsDb(
      () =>
        ({
          execute
        }) as any
    );

    await repo.findRealtimeLeaderboardDrops(
      {
        wave_id: 'wave-1',
        limit: 10,
        offset: 0,
        sort_order: PageSortDirection.DESC,
        sort_by_realtime_vote: false,
        unvoted_by_me: false,
        voter_id: null,
        curation_id: null,
        price_currency: null,
        min_price: null,
        max_price: null,
        is_additional_action_promised: null
      },
      { timer: undefined }
    );

    const [sql] = execute.mock.calls[0];
    expect(sql).toMatch(/order by\s+r\.rnk DESC,\s+r\.drop_id ASC\s+limit/);
  });

  it('orders my realtime vote sorting by voter vote direction', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new DropsDb(
      () =>
        ({
          execute
        }) as any
    );

    await repo.findRealtimeLeaderboardDropsOrderedByUsersVotesOrCreationTime(
      {
        wave_id: 'wave-1',
        voter_id: 'voter-1',
        limit: 10,
        offset: 0,
        sort_order: PageSortDirection.DESC,
        unvoted_by_me: false,
        curation_id: null,
        price_currency: null,
        min_price: null,
        max_price: null,
        is_additional_action_promised: null
      },
      { timer: undefined }
    );

    const [sql] = execute.mock.calls[0];
    expect(sql).toMatch(
      /order by\s+r\.vote DESC,\s+r\.timestamp ASC,\s+r\.drop_id ASC\s+limit/
    );
  });

  it('orders weighted realtime leaderboard sorting by weighted vote direction', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new DropsDb(
      () =>
        ({
          execute
        }) as any
    );

    await repo.findWeightedLeaderboardDrops(
      {
        wave_id: 'wave-1',
        page_size: 10,
        page: 1,
        sort_direction: PageSortDirection.DESC,
        sort: LeaderboardSort.REALTIME_VOTE,
        curation_id: null,
        unvoted_by_me: false,
        is_additional_action_promised: null,
        price_currency: null,
        min_price: null,
        max_price: null
      },
      { timer: undefined }
    );

    const [sql] = execute.mock.calls[0];
    expect(sql).toMatch(
      /order by\s+r\.vote DESC,\s+r\.timestamp ASC,\s+r\.drop_id ASC\s+limit/
    );
  });
});
