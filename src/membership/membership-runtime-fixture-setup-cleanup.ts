import {
  ADDRESS_CONSOLIDATION_KEY,
  EXTERNAL_INDEXED_OWNERSHIP_721_TABLE,
  IDENTITIES_TABLE,
  MEMBERSHIP_GENERATION_MEMBERS_TABLE,
  MEMBERSHIP_GROUP_VERSIONS_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE,
  MEMBERSHIP_REFRESH_RUNS_TABLE,
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE,
  MEMBERSHIP_SOURCE_JOBS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE,
  MEMES_CONTRACT,
  NFT_OWNERS_TABLE,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE,
  USER_GROUPS_TABLE,
  WAVES_TABLE,
  WAVE_CURATIONS_TABLE,
  XTDH_GRANTS_TABLE,
  XTDH_GRANT_TOKENS_TABLE
} from '@/constants';
import { MEMBERSHIP_GC_CHECKPOINT_ID } from './membership-gc.types';
import { MEMBERSHIP_DISPATCH_CHECKPOINT_ID } from './membership-dispatch.types';
import {
  MEMBERSHIP_FIXTURE_GROUPS,
  MEMBERSHIP_FIXTURE_PROFILES
} from './membership-runtime-policy';
import {
  fixtureAddress,
  fixtureWave,
  MEMBERSHIP_FIXTURE_EXCLUSION_LIST,
  MEMBERSHIP_FIXTURE_GRANTED_GRANT,
  MEMBERSHIP_FIXTURE_INCLUSION_LIST,
  MEMBERSHIP_FIXTURE_JOB,
  MEMBERSHIP_FIXTURE_PARTITION,
  MEMBERSHIP_FIXTURE_PENDING_GRANT,
  MEMBERSHIP_FIXTURE_TOKENSET
} from './membership-runtime-fixture-manifest';
const target =
  "((scope='PROFILE' AND target_id IN (:profiles)) OR (scope='GROUP' AND target_id IN (:groups)) OR (scope='FULL' AND target_id='*'))";
const sources =
  "((scope='GLOBAL' AND target_id='*' AND dimension IN ('GROUP_CATALOG','TDH_XTDH','RATINGS','OWNERSHIP','DELEGATIONS','GRANTS','IDENTITY')) OR (scope='PROFILE' AND target_id IN (:profiles) AND dimension IN ('TDH_XTDH','RATINGS','OWNERSHIP','DELEGATIONS','GRANTS','IDENTITY')))";
const scopes: Record<string, string> = {
  [MEMBERSHIP_PUBLICATIONS_TABLE]: 'profile_id IN (:profiles)',
  [MEMBERSHIP_GENERATION_MEMBERS_TABLE]:
    'profile_id IN (:profiles) AND group_id IN (:groups)',
  [MEMBERSHIP_REFRESH_TARGETS_TABLE]: target,
  [MEMBERSHIP_REFRESH_RUNS_TABLE]: target,
  [MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE]: 'id IN (:checkpoints)',
  [MEMBERSHIP_SOURCE_JOBS_TABLE]: `(${sources}) AND job_id IN (:jobs)`,
  [MEMBERSHIP_SOURCE_STATES_TABLE]: sources,
  [MEMBERSHIP_GROUP_VERSIONS_TABLE]: 'group_id IN (:groups)',
  [WAVE_CURATIONS_TABLE]: 'FALSE',
  [WAVES_TABLE]: 'id IN (:waves)',
  [USER_GROUPS_TABLE]: 'id IN (:groups)',
  [RATINGS_TABLE]:
    "rater_profile_id=:transport AND matter_target_id=:long AND matter='REP' AND matter_category='membership-drill'",
  [PROFILE_GROUPS_TABLE]:
    'profile_group_id IN (:lists) AND profile_id IN (:profiles)',
  [NFT_OWNERS_TABLE]:
    'wallet IN (:addresses) AND contract=:memes AND token_id IN (1,2)',
  [EXTERNAL_INDEXED_OWNERSHIP_721_TABLE]:
    '`partition`=:partition AND token_id IN (1,2) AND owner IN (:addresses)',
  [XTDH_GRANT_TOKENS_TABLE]:
    'tokenset_id=:tokenset AND token_id IN (1,2) AND target_partition=:partition',
  [XTDH_GRANTS_TABLE]: 'id IN (:grants)',
  [ADDRESS_CONSOLIDATION_KEY]:
    'address IN (:addresses) AND consolidation_key IN (:addresses)',
  [IDENTITIES_TABLE]:
    'profile_id IN (:profiles) AND consolidation_key IN (:addresses) AND primary_address IN (:addresses)'
};
export function fixtureCleanupScope(table: string) {
  const where = scopes[table];
  if (!where) throw new Error('Unknown fixture cleanup table');
  return {
    where,
    params: {
      profiles: MEMBERSHIP_FIXTURE_PROFILES,
      groups: MEMBERSHIP_FIXTURE_GROUPS,
      checkpoints: [
        MEMBERSHIP_GC_CHECKPOINT_ID,
        MEMBERSHIP_DISPATCH_CHECKPOINT_ID
      ],
      jobs: [MEMBERSHIP_FIXTURE_JOB.job_id, 'bootstrap:staging-fixture-v1'],
      waves: MEMBERSHIP_FIXTURE_GROUPS.map(
        (_, index) => fixtureWave(index, '0').id
      ),
      transport: MEMBERSHIP_FIXTURE_PROFILES[1],
      long: MEMBERSHIP_FIXTURE_PROFILES[0],
      lists: [
        MEMBERSHIP_FIXTURE_EXCLUSION_LIST,
        MEMBERSHIP_FIXTURE_INCLUSION_LIST
      ],
      addresses: [0, 1, 2].map(fixtureAddress),
      memes: MEMES_CONTRACT,
      partition: MEMBERSHIP_FIXTURE_PARTITION,
      tokenset: MEMBERSHIP_FIXTURE_TOKENSET,
      grants: [
        MEMBERSHIP_FIXTURE_PENDING_GRANT,
        MEMBERSHIP_FIXTURE_GRANTED_GRANT
      ]
    }
  };
}
