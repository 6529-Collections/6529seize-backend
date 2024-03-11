import {
  CommunityMemberOverview,
  CommunityMembersQuery
} from './community-members.types';
import { communityMembersDb, CommunityMembersDb } from './community-members.db';
import { Chunk } from '../page-request';
import { calculateLevel } from '../../../profiles/profile-level';

export class CommunityMembersService {
  constructor(private readonly communityMembersDb: CommunityMembersDb) {}

  async getCommunityMembersChunk(
    query: CommunityMembersQuery
  ): Promise<Chunk<CommunityMemberOverview>> {
    const data = await this.communityMembersDb
      .getCommunityMembers({ ...query, page_size: query.page_size + 1 })
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
    return {
      next: data.length > query.page_size,
      data: data.slice(0, query.page_size),
      page: query.page
    };
  }
}

export const communityMembersService = new CommunityMembersService(
  communityMembersDb
);
