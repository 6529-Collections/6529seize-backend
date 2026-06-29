import {
  ACTIVITY_EVENTS_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  IDENTITIES_TABLE,
  TDH_NFT_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { PageSortDirection } from '@/api/page-request';
import { DropsDb, LeaderboardSort } from './drops.db';

describe('DropsDb', () => {
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
