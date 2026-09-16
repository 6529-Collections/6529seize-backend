import { equalFixtureGeneratedExpression } from './membership-runtime-fixture-setup-metadata';
import {
  MEMBERSHIP_FIXTURE_GROUPS,
  MEMBERSHIP_FIXTURE_PROFILES
} from './membership-runtime-policy';
import {
  FixtureState,
  parseFixtureState
} from './membership-runtime-fixture-control';
import {
  fixtureGroup,
  membershipFixtureEntities,
  MEMBERSHIP_FIXTURE_CLEANUP_TABLES,
  MEMBERSHIP_FIXTURE_JOB,
  MEMBERSHIP_FIXTURE_PENDING_GRANT,
  MEMBERSHIP_FIXTURE_SOURCE_KEYS
} from './membership-runtime-fixture-manifest';
import {
  assertMembershipFixtureEnvironment,
  createMembershipFixtureDatabase,
  prepareMembershipFixtureSchema
} from './membership-runtime-fixture-setup-schema';
import { DataSource } from 'typeorm';
const state: FixtureState = {
  setup_stage: 'READY',
  input_page: 3,
  anchor_millis: '100',
  scenario: 'BASELINE',
  transport: null
};
describe('closed membership fixture manifest/control', () => {
  it('has exactly3 canonical profiles,36 broad groups and25 audited source keys', () => {
    expect(MEMBERSHIP_FIXTURE_PROFILES).toHaveLength(3);
    expect(new Set(MEMBERSHIP_FIXTURE_GROUPS).size).toBe(36);
    expect(MEMBERSHIP_FIXTURE_SOURCE_KEYS).toHaveLength(25);
    expect(MEMBERSHIP_FIXTURE_JOB.keys).toHaveLength(24);
    expect(
      MEMBERSHIP_FIXTURE_JOB.keys.some(
        (key) => key.dimension === 'GROUP_CATALOG'
      )
    ).toBe(false);
    expect(membershipFixtureEntities).toHaveLength(20);
    expect(MEMBERSHIP_FIXTURE_CLEANUP_TABLES).toHaveLength(19);
    for (let index = 0; index < 36; index++) {
      const group = fixtureGroup(index);
      expect(group.id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(group.visible).toBe(1);
      // No group is an inclusion-only group which could be pruned by the sparse planner.
      expect(
        Object.keys(group).some((key) =>
          [
            'tdh_min',
            'rep_min',
            'cic_min',
            'excluded_profile_group_id',
            'is_beneficiary_of_grant_id'
          ].includes(key)
        ) || group.owns_meme === 1
      ).toBe(true);
    }
    expect(fixtureGroup(0)).toMatchObject({
      tdh_min: 1,
      is_beneficiary_of_grant_id: MEMBERSHIP_FIXTURE_PENDING_GRANT
    });
  });
  it.each(['prod', 'local', 'development', ''])(
    'rejects stage %s before any source access',
    async (stage) => {
      const source = {} as DataSource;
      expect(() =>
        assertMembershipFixtureEnvironment({ stage, region: 'eu-west-1' })
      ).toThrow();
      await expect(
        createMembershipFixtureDatabase(
          source,
          { stage, region: 'eu-west-1' },
          'application'
        )
      ).rejects.toThrow('requires staging');
      await expect(
        prepareMembershipFixtureSchema(source, { stage, region: 'eu-west-1' })
      ).rejects.toThrow('requires staging');
    }
  );
  it('strictly decodes states and preserves large decimal counters', () => {
    expect(
      parseFixtureState(
        JSON.stringify({ ...state, anchor_millis: '9007199254740993' })
      ).anchor_millis
    ).toBe('9007199254740993');
    expect(parseFixtureState(state)).toEqual(state);
  });
  it.each([
    { ...state, extra: true },
    { ...state, input_page: 4 },
    { ...state, anchor_millis: '01' },
    { ...state, anchor_millis: 100 },
    { ...state, setup_stage: 'CLEANING' },
    { ...state, scenario: 'BOUNDARY_CAPTURED' },
    { ...state, scenario: 'IDENTITY_RECOVERED' },
    {
      ...state,
      dispatch_send_failure: {
        requested_version: '1',
        reserved_until_millis: '02'
      }
    },
    { ...state, cleanup_table: 0 },
    { ...state, cleanup_table: 0, cleanup_not_before_millis: '200' },
    { ...state, transport: { phase: 'HELD', message_id: 'invalid' } }
  ])('rejects malformed or phase-inconsistent state %#', (value) => {
    expect(() => parseFixtureState(value)).toThrow();
  });
  it('bounds the full encoded control state', () => {
    expect(() => parseFixtureState(' '.repeat(16385))).toThrow('exceeds limit');
  });
  it('strictly binds captured horizon and retry receipts to their phases', () => {
    const captured = {
      run_id: '11111111-1111-4111-8111-111111111111',
      request_version: '2',
      checkpoint_version: '1',
      evaluation_time_millis: '100',
      valid_until_millis: '200',
      superseded_observed_at_millis: null
    };
    const proof = {
      protocol_version: 1 as const,
      boundary: {
        boundary_millis: '200',
        full_request_version: '2',
        grants_version: '3',
        captured,
        false_publication_run_id: null
      }
    };
    expect(
      parseFixtureState({ ...state, scenario: 'BOUNDARY_CAPTURED', proof })
        .proof
    ).toEqual(proof);
    for (const change of [
      { evaluation_time_millis: '200' },
      { valid_until_millis: '201' },
      { checkpoint_version: '0' },
      { superseded_observed_at_millis: '199' }
    ])
      expect(() =>
        parseFixtureState({
          ...state,
          scenario: 'BOUNDARY_CAPTURED',
          proof: {
            ...proof,
            boundary: {
              ...proof.boundary,
              captured: { ...captured, ...change }
            }
          }
        })
      ).toThrow();
    const identity_retry = {
      requested_version: '5',
      peer_requested_version: '4',
      previous_publication_run_id: captured.run_id,
      observations: [
        { attempts: 1, observed_at_millis: '100', available_at_millis: '200' }
      ],
      parked_observed_at_millis: null
    };
    expect(
      parseFixtureState({
        ...state,
        scenario: 'IDENTITY_MISSING',
        proof: { protocol_version: 1, identity_retry }
      }).proof?.identity_retry
    ).toEqual(identity_retry);
    expect(() =>
      parseFixtureState({
        ...state,
        scenario: 'IDENTITY_MISSING',
        proof: {
          protocol_version: 1,
          identity_retry: {
            ...identity_retry,
            observations: [
              ...identity_retry.observations,
              ...identity_retry.observations
            ]
          }
        }
      })
    ).toThrow('retry observation');
  });
});

describe('fixture generated-column recovery grammar', () => {
  const original =
    'profile_group_id IS NOT NULL AND tdh_min IS NULL AND COALESCE(owns_meme, 0) = 0';
  it('accepts MySQL parentheses/backticks while preserving each predicate', () => {
    expect(
      equalFixtureGeneratedExpression(
        '((`profile_group_id` is not null) and (`tdh_min` is null) and (coalesce(`owns_meme`,0) = 0))',
        original
      )
    ).toBe(true);
  });
  it.each([
    'profile_group_id is not null OR tdh_min is null AND coalesce(owns_meme,0)=0',
    'profile_group_id is null AND tdh_min is null AND coalesce(owns_meme,0)=0',
    'profile_group_id is not null AND tdh_min is null AND coalesce(owns_meme,0=0)',
    'profile_group_id is not null AND tdh_min is null AND coalesce(owns_meme,1)=0',
    '1',
    '('.repeat(100)
  ])('rejects changed or malformed expression %#', (expression) => {
    expect(equalFixtureGeneratedExpression(expression, original)).toBe(false);
  });
});
