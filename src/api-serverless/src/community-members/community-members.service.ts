import {
  CommunityMemberOverview,
  CommunityMembersQuery
} from './community-members.types';
import { communityMembersDb, CommunityMembersDb } from './community-members.db';
import { calculateLevel } from '../../../profiles/profile-level';
import { Page } from '../page-request';

export class CommunityMembersService {
  constructor(private readonly communityMembersDb: CommunityMembersDb) {}

  async getCommunityMembersChunk(
    query: CommunityMembersQuery
  ): Promise<Page<CommunityMemberOverview>> {
    const [data, count] = await Promise.all([
      this.getAndConvertCommunityMembers(query),
      this.communityMembersDb.countCommunityMembers(query)
    ]);
    return {
      next: count > query.page_size * query.page,
      data: data,
      page: query.page,
      count: count
    };
  }

  private async getAndConvertCommunityMembers(
    query: CommunityMembersQuery
  ): Promise<CommunityMemberOverview[]> {
    return await this.communityMembersDb
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
      });
  }
}

export const communityMembersService = new CommunityMembersService(
  communityMembersDb
);
