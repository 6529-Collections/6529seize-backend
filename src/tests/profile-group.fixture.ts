import { ProfileGroupEntity } from '../entities/IProfileGroup';

export function aProfileGroup(params: ProfileGroupEntity): ProfileGroupEntity {
  return {
    ...params
  };
}
