import {
  CommunityMemberOverview,
  CommunityMembersQuery
} from './community-members.types';
import { communityMembersDb, CommunityMembersDb } from './community-members.db';
import { calculateLevel } from '../../../profiles/profile-level';
import { Page } from '../page-request';
import { RequestContext } from '../../../request.context';

export class CommunityMembersService {
  constructor(private readonly communityMembersDb: CommunityMembersDb) {}

  async getCommunityMembersPage(
    query: CommunityMembersQuery,
    ctx: RequestContext
  ): Promise<Page<CommunityMemberOverview>> {
    const [data, count] = await Promise.all([
      this.getAndConvertCommunityMembers(query, ctx),
      this.communityMembersDb.countCommunityMembers(query, ctx)
    ]);
    return {
      next: count > query.page_size * query.page,
      data: data,
      page: query.page,
      count: count
    };
  }

  private async getAndConvertCommunityMembers(
    query: CommunityMembersQuery,
    ctx: RequestContext
  ): Promise<CommunityMemberOverview[]> {
    return await this.communityMembersDb
      .getCommunityMembers(query, ctx)
      .then(async (members) => {
        const consolidationKeys = members.map(
          (member) => member.consolidation_key
        );
        const lastActivities =
          await this.communityMembersDb.getCommunityMembersLastActivitiesByConsolidationKeys(
            consolidationKeys,
            ctx
          );
        return members.map((member) => ({
          display: member.display,
          detail_view_key: member.detail_view_key,
          level: calculateLevel({ tdh: member.tdh, rep: member.rep }),
          tdh: member.tdh,
          rep: member.rep,
          cic: member.cic,
          last_activity: lastActivities[member.consolidation_key] ?? null,
          pfp: member.pfp,
          wallet: member.wallet
        }));
      });
  }
}

export const communityMembersService = new CommunityMembersService(
  communityMembersDb
);
