import { MEMES_CONTRACT, IDENTITIES_TABLE, TDH_NFT_TABLE } from '@/constants';
import { IdentitiesDb } from './identities.db';

describe('IdentitiesDb', () => {
  it('loads card-set voting credits through distinct profile consolidation keys', async () => {
    const execute = jest.fn().mockResolvedValue([
      {
        contract: MEMES_CONTRACT.toLowerCase(),
        token_id: 1,
        boosted_tdh: 7
      }
    ]);
    const repo = new IdentitiesDb(
      () =>
        ({
          execute
        }) as any
    );

    const result = await repo.getSingleNftVotingCreditsByProfileId(
      'profile-1',
      [{ contract: MEMES_CONTRACT.toLowerCase(), tokenId: 1 }],
      { timer: undefined }
    );

    expect(result).toEqual({
      [`${MEMES_CONTRACT.toLowerCase()}:1`]: 7
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain(`SELECT DISTINCT consolidation_key`);
    expect(sql).toContain(`FROM ${IDENTITIES_TABLE}`);
    expect(sql).toContain(`FROM ${TDH_NFT_TABLE} t`);
    expect(sql).toContain(`WHERE t.contract = :contract`);
    expect(sql).toContain(`AND t.id IN (:tokenIds)`);
    expect(sql).toContain(`ON i.consolidation_key = t.consolidation_key`);
    expect(params).toMatchObject({
      profileId: 'profile-1',
      contract: MEMES_CONTRACT.toLowerCase(),
      tokenIds: [1]
    });
  });

  it('searches wave mentions by indexed handle prefix and level', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new IdentitiesDb(
      () =>
        ({
          execute
        }) as any
    );

    await repo.searchWaveMentionCandidates(
      {
        handle: 'Ali',
        limit: 5,
        excludedProfileId: 'profile-me'
      },
      null,
      { timer: undefined }
    );

    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain('force index (identity_normalised_handle_idx)');
    expect(sql).toContain('i.normalised_handle like :mentionHandlePrefix');
    expect(sql).toContain('i.level_raw desc');
    expect(sql).toContain('i.profile_id <> :mentionExcludedProfileId');
    expect(sql).not.toContain('join user_groups_view');
    expect(params).toMatchObject({
      mentionHandlePrefix: 'ali%',
      mentionExcludedProfileId: 'profile-me',
      mentionLimit: 5
    });
  });

  it('restricts wave mention candidates to the supplied eligibility view', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new IdentitiesDb(
      () =>
        ({
          execute
        }) as any
    );
    const eligibility = {
      sql: 'with user_groups_view as (select * from eligible_profiles)',
      params: { eligibilityGroupId: 'group-1' }
    };

    await repo.searchWaveMentionCandidates(
      { handle: 'ali', limit: 5, excludedProfileId: null },
      eligibility,
      { timer: undefined }
    );

    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain(eligibility.sql);
    expect(sql).toContain(
      'join user_groups_view ug on ug.profile_id = i.profile_id'
    );
    expect(sql).not.toContain('i.profile_id <> :mentionExcludedProfileId');
    expect(params).toMatchObject({
      eligibilityGroupId: 'group-1',
      mentionHandlePrefix: 'ali%',
      mentionLimit: 5
    });
  });

  it('excludes the acting profile when an eligibility view is supplied', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new IdentitiesDb(
      () =>
        ({
          execute
        }) as any
    );
    const eligibility = {
      sql: 'with user_groups_view as (select * from eligible_profiles)',
      params: { eligibilityGroupId: 'group-1' }
    };

    await repo.searchWaveMentionCandidates(
      { handle: 'ali', limit: 5, excludedProfileId: 'profile-me' },
      eligibility,
      { timer: undefined }
    );

    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain(
      'join user_groups_view ug on ug.profile_id = i.profile_id'
    );
    expect(sql).toContain('i.profile_id <> :mentionExcludedProfileId');
    expect(params).toMatchObject({
      eligibilityGroupId: 'group-1',
      mentionHandlePrefix: 'ali%',
      mentionExcludedProfileId: 'profile-me',
      mentionLimit: 5
    });
  });
});
