import { MEMBERSHIP_FIXTURE_CLEANUP_TABLES } from './membership-runtime-fixture-control-layout';
import { createHash } from 'node:crypto';
import { AddressConsolidationKey } from '@/entities/IAddressConsolidationKey';
import { ExternalIndexedOwnership721Entity } from '@/entities/IExternalIndexedOwnership721';
import { IdentityEntity } from '@/entities/IIdentity';
import { MembershipRuntimeCheckpointEntity } from '@/entities/IMembershipRuntimeCheckpoint';
import { NFTOwner } from '@/entities/INFTOwner';
import { ProfileGroupEntity } from '@/entities/IProfileGroup';
import { Rating } from '@/entities/IRating';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { WaveEntity } from '@/entities/IWave';
import { WaveCurationEntity } from '@/entities/IWaveCuration';
import { XTdhGrantEntity } from '@/entities/IXTdhGrant';
import { XTdhGrantTokenEntity } from '@/entities/IXTdhGrantToken';
import { membershipSchemaEntities } from '@/dbMigrationsLoop/membership-schema';
import { MembershipFixtureControlEntity } from './membership-runtime-fixture-control';
import {
  MEMBERSHIP_FIXTURE_CONTROL_TABLE,
  MEMBERSHIP_FIXTURE_GROUPS,
  MEMBERSHIP_FIXTURE_PROFILES
} from './membership-runtime-policy';
import { membershipProfileSourceKeys } from './membership-profile-evaluator';
import { orderedSourceKeys } from './membership-validation';

export const membershipFixtureEntities = [
  IdentityEntity,
  UserGroupEntity,
  ProfileGroupEntity,
  WaveEntity,
  WaveCurationEntity,
  AddressConsolidationKey,
  Rating,
  NFTOwner,
  XTdhGrantEntity,
  XTdhGrantTokenEntity,
  ExternalIndexedOwnership721Entity,
  ...membershipSchemaEntities,
  MembershipRuntimeCheckpointEntity,
  MembershipFixtureControlEntity
];
export const MEMBERSHIP_FIXTURE_MANIFEST_HASH = createHash('sha256')
  .update(
    JSON.stringify({
      protocol: 1,
      spec: 2,
      seed_revision: 2,
      schema_revision: 1,
      profiles: MEMBERSHIP_FIXTURE_PROFILES,
      groups: MEMBERSHIP_FIXTURE_GROUPS,
      tables: [
        ...MEMBERSHIP_FIXTURE_CLEANUP_TABLES,
        MEMBERSHIP_FIXTURE_CONTROL_TABLE,
        'typeorm_metadata'
      ]
    })
  )
  .digest('hex');
export const MEMBERSHIP_FIXTURE_SOURCE_KEYS = orderedSourceKeys(
  Array.from(
    new Map(
      MEMBERSHIP_FIXTURE_PROFILES.flatMap(membershipProfileSourceKeys).map(
        (key) => [`${key.scope}/${key.target_id}/${key.dimension}`, key]
      )
    ).values()
  )
);
export const MEMBERSHIP_FIXTURE_JOB = {
  job_id: 'staging-fixture-inputs-v1',
  keys: MEMBERSHIP_FIXTURE_SOURCE_KEYS.filter(
    (key) => key.dimension !== 'GROUP_CATALOG'
  )
};
export const MEMBERSHIP_FIXTURE_PARTITION = 'membership-drill-partition-v1';
export const MEMBERSHIP_FIXTURE_TOKENSET = 'membership-drill-tokens-v1';
export const MEMBERSHIP_FIXTURE_PENDING_GRANT = 'membership-drill-pending-v1';
export const MEMBERSHIP_FIXTURE_GRANTED_GRANT = 'membership-drill-granted-v1';
export const MEMBERSHIP_FIXTURE_EXCLUSION_LIST = 'membership-drill-excluded-v1';
export const MEMBERSHIP_FIXTURE_INCLUSION_LIST = 'membership-drill-included-v1';
export const fixtureAddress = (index: number) =>
  `0x${String(index + 652900).padStart(40, '0')}`;
export function fixtureGroup(index: number) {
  const [long, transport] = MEMBERSHIP_FIXTURE_PROFILES;
  const base = {
    id: MEMBERSHIP_FIXTURE_GROUPS[index],
    name: `Membership drill ${index + 1}`,
    created_at: '2026-01-01 00:00:00',
    created_by: long,
    visible: 1,
    owns_meme: 0,
    owns_gradient: 0,
    owns_nextgen: 0,
    owns_lab: 0
  };
  const rules: Record<string, unknown>[] = [
    { excluded_profile_group_id: MEMBERSHIP_FIXTURE_EXCLUSION_LIST },
    { tdh_min: 100000 },
    { tdh_min: 1, profile_group_id: MEMBERSHIP_FIXTURE_INCLUSION_LIST },
    {
      rep_min: 2,
      rep_user: transport,
      rep_direction: 'RECEIVED',
      rep_category: 'membership-drill'
    },
    {
      owns_meme: 1,
      owns_meme_tokens: '["1"]',
      owns_meme_tokens_match_mode: 'ALL_TOKENS'
    },
    {
      owns_meme: 1,
      owns_meme_tokens: '["1","2"]',
      owns_meme_tokens_match_mode: 'ANY_TOKEN'
    },
    {
      is_beneficiary_of_grant_id: MEMBERSHIP_FIXTURE_GRANTED_GRANT,
      is_beneficiary_of_grant_match_mode: 'ANY_TOKEN'
    },
    {
      is_beneficiary_of_grant_id: MEMBERSHIP_FIXTURE_GRANTED_GRANT,
      is_beneficiary_of_grant_match_mode: 'ALL_TOKENS'
    },
    {
      is_beneficiary_of_grant_id: MEMBERSHIP_FIXTURE_PENDING_GRANT,
      is_beneficiary_of_grant_match_mode: 'ANY_TOKEN'
    },
    {
      is_beneficiary_of_grant_id: MEMBERSHIP_FIXTURE_PENDING_GRANT,
      is_beneficiary_of_grant_match_mode: 'ALL_TOKENS'
    },
    { cic_min: 100000 },
    { tdh_min: 1, excluded_profile_group_id: MEMBERSHIP_FIXTURE_EXCLUSION_LIST }
  ];
  if (!base.id) throw new Error('Invalid fixed fixture group ordinal');
  if (index === 0)
    return {
      ...base,
      tdh_min: 1,
      is_beneficiary_of_grant_id: MEMBERSHIP_FIXTURE_PENDING_GRANT,
      is_beneficiary_of_grant_match_mode: 'ANY_TOKEN'
    };
  return { ...base, ...(index < 24 ? { tdh_min: 1 } : rules[index - 24]) };
}
export function fixtureWave(index: number, anchor: string) {
  return {
    id: `membership-drill-wave-${String(index + 1).padStart(3, '0')}`,
    name: `Membership drill ${index + 1}`,
    description_drop_id: 'membership-drill-description-v1',
    created_by: MEMBERSHIP_FIXTURE_PROFILES[0],
    created_at: anchor,
    visibility_group_id: MEMBERSHIP_FIXTURE_GROUPS[index],
    voting_credit_type: 'TDH',
    voting_signature_required: 0,
    participation_required_metadata: '[]',
    participation_required_media: '[]',
    type: 'CHAT'
  };
}

export { MEMBERSHIP_FIXTURE_CLEANUP_TABLES } from './membership-runtime-fixture-control-layout';
