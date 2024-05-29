import { UserGroup } from './user-group.types';
import { ProfileMin } from '../generated/models/ProfileMin';

export interface ApiUserGroup {
  readonly id: string;
  readonly name: string;
  readonly group: UserGroup;
  readonly created_at: Date;
  readonly created_by: ProfileMin | null;
  readonly visible: boolean;
}
