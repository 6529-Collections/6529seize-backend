import { IdentityEntity } from '../../entities/IIdentity';
import { ProfileClassification } from '../../entities/IProfile';
import { Wallet } from 'ethers';
import { randomUUID } from 'node:crypto';
import { Seed } from '../_setup/seed';
import { IDENTITIES_TABLE } from '@/constants';

type BaseIdentity = Omit<
  IdentityEntity,
  | 'consolidation_key'
  | 'profile_id'
  | 'primary_address'
  | 'handle'
  | 'normalised_handle'
>;

const defaultBaseIdentity: BaseIdentity = {
  tdh: 0,
  rep: 0,
  cic: 0,
  level_raw: 0,
  pfp: null,
  banner1: null,
  banner2: null,
  classification: ProfileClassification.PSEUDONYM,
  sub_classification: randomUUID(),
  xtdh: 0,
  produced_xtdh: 0,
  granted_xtdh: 0,
  xtdh_rate: 0,
  basetdh_rate: 0
};

export function aRandomIdentityKey(): {
  consolidation_key: string;
  profile_id: string;
  primary_address: string;
  handle: string;
} {
  const wallet = Wallet.createRandom().address.toLowerCase();
  return {
    consolidation_key: wallet,
    profile_id: randomUUID(),
    primary_address: wallet,
    handle: `id-${wallet}`
  };
}

export function anIdentity(
  other: Partial<BaseIdentity>,
  identityKey?: {
    consolidation_key: string;
    profile_id: string;
    primary_address: string;
    handle: string;
  }
): IdentityEntity {
  const key = identityKey ?? aRandomIdentityKey();
  return {
    ...key,
    normalised_handle: key.handle.toLowerCase(),
    ...defaultBaseIdentity,
    ...other
  };
}

export function withIdentities(entities: IdentityEntity[]): Seed {
  return {
    table: IDENTITIES_TABLE,
    rows: entities
  };
}
