import { Profile, ProfileClassification } from '@/entities/IProfile';
import { Time } from '@/time';
import { Seed } from '@/tests/_setup/seed';
import { PROFILES_TABLE } from '@/constants';

type BaseProfile = Omit<
  Profile,
  | 'external_id'
  | 'handle'
  | 'normalised_handle'
  | 'primary_wallet'
  | 'created_by_wallet'
>;

const defaultBaseProfile: BaseProfile = {
  created_at: Time.millis(0).toDate(),
  updated_at: null,
  classification: ProfileClassification.PSEUDONYM,
  sub_classification: null
};

export function aProfile(
  profileKey: {
    external_id: string;
    handle: string;
    primary_wallet: string;
  },
  other: Partial<BaseProfile> = {}
): Profile {
  return {
    ...profileKey,
    normalised_handle: profileKey.handle.toLowerCase(),
    created_by_wallet: profileKey.primary_wallet,
    ...defaultBaseProfile,
    ...other
  };
}

export function withProfiles(entities: Profile[]): Seed {
  return {
    table: PROFILES_TABLE,
    rows: entities
  };
}
