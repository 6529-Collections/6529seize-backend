import { IdentityEntity } from '@/entities/IIdentity';
import { IdentityFetcher } from './identity.fetcher';

const createIdentity = ({
  handle,
  levelRaw,
  profileId,
  ens = null
}: {
  handle: string;
  levelRaw: number;
  profileId: string;
  ens?: string | null;
}): IdentityEntity & { ens: string | null } =>
  ({
    consolidation_key: `consolidation-${profileId}`,
    profile_id: profileId,
    primary_address: `wallet-${profileId}`,
    handle,
    normalised_handle: handle.toLowerCase(),
    tdh: 1,
    rep: 0,
    cic: 0,
    level_raw: levelRaw,
    pfp: null,
    ens
  }) as IdentityEntity & { ens: string | null };

describe('IdentityFetcher community-member search', () => {
  const searchCommunityMembersWhereHandleLike = jest.fn();
  const searchCommunityMembersWhereEnsLike = jest.fn();
  const identityFetcher = new IdentityFetcher(
    {
      searchCommunityMembersWhereHandleLike,
      searchCommunityMembersWhereEnsLike
    } as never,
    {} as never,
    {} as never,
    {} as never,
    jest.fn()
  );

  beforeEach(() => {
    jest.clearAllMocks();
    searchCommunityMembersWhereEnsLike.mockResolvedValue([]);
  });

  it('orders real handles by exact, prefix, and substring buckets before ENS and auto-wallet matches', async () => {
    searchCommunityMembersWhereHandleLike.mockResolvedValue([
      createIdentity({
        handle: 'gelbeta',
        levelRaw: 200,
        profileId: 'profile-beta'
      }),
      createIdentity({
        handle: 'gelalpha',
        levelRaw: 200,
        profileId: 'profile-alpha'
      }),
      createIdentity({
        handle: 'gelhigh',
        levelRaw: 300,
        profileId: 'profile-high'
      }),
      createIdentity({
        handle: 'mygelmatch',
        levelRaw: 500,
        profileId: 'profile-substring'
      }),
      createIdentity({
        handle: 'gel',
        levelRaw: 1,
        profileId: 'profile-exact'
      })
    ]);
    searchCommunityMembersWhereEnsLike.mockResolvedValue([
      createIdentity({
        handle: 'id-0x123',
        levelRaw: 1000,
        profileId: 'profile-auto-wallet',
        ens: 'qengel.eth'
      })
    ]);

    const results =
      await identityFetcher.searchCommunityMemberMinimalsOfClosestMatches({
        param: 'gel',
        onlyProfileOwners: true,
        limit: 10,
        sort: 'level'
      });

    expect(results.map((result) => result.handle)).toEqual([
      'gel',
      'gelhigh',
      'gelalpha',
      'gelbeta',
      'mygelmatch',
      'id-0x123'
    ]);
    expect(searchCommunityMembersWhereHandleLike).toHaveBeenCalledWith({
      handle: 'gel',
      limit: 30,
      sortByLevel: true
    });
    expect(searchCommunityMembersWhereEnsLike).toHaveBeenCalledWith({
      ensCandidate: 'gel',
      limit: 30,
      onlyProfileOwners: true,
      sortByLevel: true
    });
  });

  it('orders real-handle ENS-only matches in the ENS and wallet bucket', async () => {
    searchCommunityMembersWhereHandleLike.mockResolvedValue([
      createIdentity({
        handle: 'gelprefix',
        levelRaw: 1,
        profileId: 'profile-prefix'
      })
    ]);
    searchCommunityMembersWhereEnsLike.mockResolvedValue([
      createIdentity({
        handle: 'unrelated-handle',
        levelRaw: 500,
        profileId: 'profile-ens-only',
        ens: 'highgel.eth'
      }),
      createIdentity({
        handle: 'id-0x123',
        levelRaw: 100,
        profileId: 'profile-auto-wallet',
        ens: 'lowgel.eth'
      })
    ]);

    const results =
      await identityFetcher.searchCommunityMemberMinimalsOfClosestMatches({
        param: 'gel',
        onlyProfileOwners: true,
        limit: 10,
        sort: 'level'
      });

    expect(results.map((result) => result.handle)).toEqual([
      'gelprefix',
      'unrelated-handle',
      'id-0x123'
    ]);
  });

  it('uses the widened source window to fill results after ENS deduplication', async () => {
    const duplicateProfile = createIdentity({
      handle: 'gelprefix',
      levelRaw: 1000,
      profileId: 'profile-prefix',
      ens: 'gel-one.eth'
    });
    const secondDuplicate = {
      ...duplicateProfile,
      ens: 'gel-two.eth'
    };
    searchCommunityMembersWhereHandleLike.mockResolvedValue([duplicateProfile]);
    searchCommunityMembersWhereEnsLike.mockResolvedValue([
      duplicateProfile,
      secondDuplicate,
      createIdentity({
        handle: 'id-0x123',
        levelRaw: 900,
        profileId: 'profile-ens-only',
        ens: 'gel-three.eth'
      })
    ]);

    const results =
      await identityFetcher.searchCommunityMemberMinimalsOfClosestMatches({
        param: 'gel',
        onlyProfileOwners: true,
        limit: 2,
        sort: 'level'
      });

    expect(results.map((result) => result.handle)).toEqual([
      'gelprefix',
      'id-0x123'
    ]);
    expect(searchCommunityMembersWhereHandleLike).toHaveBeenCalledWith({
      handle: 'gel',
      limit: 6,
      sortByLevel: true
    });
    expect(searchCommunityMembersWhereEnsLike).toHaveBeenCalledWith({
      ensCandidate: 'gel',
      limit: 6,
      onlyProfileOwners: true,
      sortByLevel: true
    });
  });

  it('keeps the existing relevance mode as the default', async () => {
    searchCommunityMembersWhereHandleLike.mockResolvedValue([
      createIdentity({
        handle: 'mygelmatch',
        levelRaw: 300,
        profileId: 'profile-substring'
      }),
      createIdentity({
        handle: 'gelprefix',
        levelRaw: 1,
        profileId: 'profile-prefix'
      })
    ]);

    const results =
      await identityFetcher.searchCommunityMemberMinimalsOfClosestMatches({
        param: 'gel',
        onlyProfileOwners: true,
        limit: 10
      });

    expect(results.map((result) => result.handle)).toEqual([
      'gelprefix',
      'mygelmatch'
    ]);
    expect(searchCommunityMembersWhereHandleLike).toHaveBeenCalledWith({
      handle: 'gel',
      limit: 30,
      sortByLevel: false
    });
  });
});
