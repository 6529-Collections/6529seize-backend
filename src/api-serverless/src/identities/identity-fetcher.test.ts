import type { CicDb } from '@/cic/cic.db';
import type { IdentityEntity } from '@/entities/IIdentity';
import type { IdentitiesDb } from '@/identities/identities.db';
import type { RatingsDb } from '@/rates/ratings.db';
import type { IdentitySubscriptionsDb } from '@/api/identity-subscriptions/identity-subscriptions.db';
import { IdentityFetcher } from './identity.fetcher';

describe('IdentityFetcher', () => {
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
    const fetcher = new IdentityFetcher(
      identitiesDb,
      {} as IdentitySubscriptionsDb,
      {} as CicDb,
      {} as RatingsDb,
      () => {
        throw new Error('Alchemy is not used by community-member search');
      }
    );

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
});
