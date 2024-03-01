import {
  CommunityMemberOverview,
  CommunityMembersQuery
} from './community-members.types';
import { communityMembersDb, CommunityMembersDb } from './community-members.db';
import { Page } from '../page-request';
import { calculateLevel } from '../../../profiles/profile-level';

export class CommunityMembersService {
  constructor(private readonly communityMembersDb: CommunityMembersDb) {}

  async getCommunityMembersPage(
    query: CommunityMembersQuery
  ): Promise<Page<CommunityMemberOverview>> {
    const [data, count] = await Promise.all([
      this.communityMembersDb
        .getCommunityMembers(query)
        .then(async (members) => {
          const consolidationKeys = members.map(
            (member) => member.consolidation_key
          );
          const lastActivities =
            await this.communityMembersDb.getCommunityMembersLastActivitiesByConsolidationKeys(
              consolidationKeys
            );
          return members.map((member) => ({
            display: member.display,
            detail_view_key: member.detail_view_key,
            level: calculateLevel({ tdh: member.tdh, rep: member.rep }),
            tdh: member.tdh,
            rep: member.rep,
            cic: member.cic,
            last_activity: lastActivities[member.consolidation_key] ?? null,
            pfp: member.pfp
          }));
        }),
      this.communityMembersDb.countCommunityMembers()
    ]);
    return {
      count,
      next: !!data.length,
      page: query.page,
      data
    };
  }
}

export const communityMembersService = new CommunityMembersService(
  communityMembersDb
);
