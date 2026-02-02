import {
  GroupTdhInclusionStrategy,
  UserGroupEntity
} from '../../entities/IUserGroup';
import { Time } from '../../time';
import { randomUUID } from 'node:crypto';
import { Seed } from '../_setup/seed';
import { USER_GROUPS_TABLE } from '../../constants';

type BaseUserGroup = Omit<UserGroupEntity, 'id' | 'name'>;

const aDefaultUserGroup: BaseUserGroup = {
  cic_min: null,
  cic_max: null,
  cic_user: null,
  cic_direction: null,
  rep_min: null,
  rep_max: null,
  rep_user: null,
  rep_direction: null,
  rep_category: null,
  tdh_min: null,
  tdh_max: null,
  tdh_inclusion_strategy: GroupTdhInclusionStrategy.TDH,
  level_min: null,
  level_max: null,
  owns_meme: false,
  owns_gradient: false,
  owns_lab: false,
  owns_nextgen: false,
  owns_meme_tokens: null,
  owns_gradient_tokens: null,
  owns_lab_tokens: null,
  owns_nextgen_tokens: null,
  visible: true,
  is_private: false,
  is_direct_message: true,
  created_at: Time.millis(0).toDate(),
  created_by: randomUUID(),
  profile_group_id: null,
  excluded_profile_group_id: null,
  is_beneficiary_of_grant_id: null
};

export function aUserGroup(
  params: Partial<BaseUserGroup>,
  suppliedKey?: {
    id: string;
    name: string;
  }
): UserGroupEntity {
  const key = suppliedKey ?? {
    id: randomUUID(),
    name: randomUUID()
  };
  return {
    ...key,
    ...aDefaultUserGroup,
    ...params
  };
}

export function withUserGroups(entities: UserGroupEntity[]): Seed {
  return {
    table: USER_GROUPS_TABLE,
    rows: entities
  };
}
