import { FullPageRequest } from '../page-request';

export interface CommunityMemberOverview {
  readonly display: string;
  readonly detail_view_key: string;
  readonly level: number;
  readonly tdh: number;
  readonly rep: number;
  readonly cic: number;
  readonly pfp: string | null;
  readonly last_activity: number | null;
  readonly wallet: string;
}

export enum CommunityMembersSortOption {
  DISPLAY = 'display',
  LEVEL = 'level',
  TDH = 'tdh',
  REP = 'rep',
  CIC = 'cic'
}

export interface CommunityMembersQuery
  extends FullPageRequest<CommunityMembersSortOption> {
  readonly group_id: string | null;
  readonly joinWithOnlineWebsocketListeners?: boolean;
}
