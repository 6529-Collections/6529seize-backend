import type { CicDb } from '@/cic/cic.db';
import type { IdentityEntity } from '@/entities/IIdentity';
import type { IdentitiesDb } from '@/identities/identities.db';
import type { RatingsDb } from '@/rates/ratings.db';
import type { IdentitySubscriptionsDb } from '@/api/identity-subscriptions/identity-subscriptions.db';
import { IdentityFetcher } from './identity.fetcher';

describe('IdentityFetcher', () => {
  const createIdentity = ({
    consolidationKey,
    handle,
    address
  }: {
    consolidationKey: string;
    handle: string;
    address: string;
  }): IdentityEntity =>
    ({
      consolidation_key: consolidationKey,
      profile_id: consolidationKey,
      primary_address: address,
      handle,
      normalised_handle: handle.toLowerCase(),
      tdh: 1,
      level_raw: 0,
      cic: 0,
      pfp: null
    }) as IdentityEntity;

  const createFetcher = (identitiesDb: IdentitiesDb) =>
    new IdentityFetcher(
      identitiesDb,
      {} as IdentitySubscriptionsDb,
      {} as CicDb,
      {} as RatingsDb,
      () => {
        throw new Error('Alchemy is not used by community-member search');
      }
    );

  it('runs handle and ENS community-member searches concurrently', async () => {
    let resolveHandleSearch: (members: IdentityEntity[]) => void = () =>
      undefined;
    let resolveEnsSearch: (
      members: (IdentityEntity & { ens: string })[]
    ) => void = () => undefined;
    const handleSearch = new Promise<IdentityEntity[]>((resolve) => {
      resolveHandleSearch = resolve;
    });
    const ensSearch = new Promise<(IdentityEntity & { ens: string })[]>(
      (resolve) => {
        resolveEnsSearch = resolve;
      }
    );
    const identitiesDb = {
      searchCommunityMembersWhereHandleLike: jest
        .fn()
        .mockReturnValue(handleSearch),
      searchCommunityMembersWhereEnsLike: jest.fn().mockReturnValue(ensSearch)
    } as unknown as IdentitiesDb;
    const fetcher = createFetcher(identitiesDb);

    const result = fetcher.searchCommunityMemberMinimalsOfClosestMatches({
      param: 'signers',
      onlyProfileOwners: false,
      limit: 10
    });

    expect(
      identitiesDb.searchCommunityMembersWhereHandleLike
    ).toHaveBeenCalledWith({
      handle: 'signers',
      limit: 30
    });
    expect(
      identitiesDb.searchCommunityMembersWhereEnsLike
    ).toHaveBeenCalledWith({
      ensCandidate: 'signers',
      onlyProfileOwners: false,
      limit: 30
    });

    resolveHandleSearch([]);
    resolveEnsSearch([]);
    await expect(result).resolves.toEqual([]);
  });

  it('preserves ENS ranking data when handle and ENS matches overlap', async () => {
    const overlappingIdentity = createIdentity({
      consolidationKey: 'profile-with-ens',
      handle: 'bravo-signers',
      address: '0x0000000000000000000000000000000000000001'
    });
    const otherIdentity = createIdentity({
      consolidationKey: 'profile-without-ens',
      handle: 'alpha-signers',
      address: '0x0000000000000000000000000000000000000002'
    });
    const identitiesDb = {
      searchCommunityMembersWhereHandleLike: jest
        .fn()
        .mockResolvedValue([otherIdentity, overlappingIdentity]),
      searchCommunityMembersWhereEnsLike: jest.fn().mockResolvedValue([
        {
          ...overlappingIdentity,
          ens: 'signers.eth'
        }
      ])
    } as unknown as IdentitiesDb;
    const fetcher = createFetcher(identitiesDb);

    const result = await fetcher.searchCommunityMemberMinimalsOfClosestMatches({
      param: 'signers',
      onlyProfileOwners: false,
      limit: 10
    });

    expect(result.map((member) => member.profile_id)).toEqual([
      'profile-with-ens',
      'profile-without-ens'
    ]);
  });
});
