import { ApiCommunityMembersSortOption } from '../generated/models/ApiCommunityMembersSortOption';
import { FullPageRequest } from '../page-request';

export interface CommunityMembersQuery
  extends FullPageRequest<ApiCommunityMembersSortOption> {
  readonly group_id: string | null;
  readonly joinWithOnlineWebsocketListeners?: boolean;
}
