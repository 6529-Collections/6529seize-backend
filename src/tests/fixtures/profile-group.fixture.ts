import { ProfileGroupEntity } from '../../entities/IProfileGroup';
import { Seed } from '../_setup/seed';
import { PROFILE_GROUPS_TABLE } from '@/constants';

export function aProfileGroup(params: ProfileGroupEntity): ProfileGroupEntity {
  return {
    ...params
  };
}

export function withProfileGroups(entities: ProfileGroupEntity[]): Seed {
  return {
    table: PROFILE_GROUPS_TABLE,
    rows: entities
  };
}
