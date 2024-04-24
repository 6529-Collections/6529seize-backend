import { CommunityMembersCurationCriteria } from './community-search-criteria.types';
import { ProfileMin } from '../generated/models/ProfileMin';

export interface ApiCommunityMembersCurationCriteria {
  readonly id: string;
  readonly name: string;
  readonly criteria: CommunityMembersCurationCriteria;
  readonly created_at: Date;
  readonly created_by: ProfileMin | null;
  readonly visible: boolean;
}
