import {
  getReleaseBusV2BetaAllowlist,
  getReleaseBusV2Mode,
  releaseBusV2BetaAllowsCandidate,
  releaseBusV2BetaAllowsRegistration,
  ReleaseBusV2BetaConfigurationError
} from '@/releaseBusV2/release-bus-v2.config';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2RegisterInput
} from '@/releaseBusV2/release-bus-v2.types';

const CANDIDATE_ID = '11111111-1111-4111-8111-111111111111';

function configuredEntry(overrides: Record<string, unknown> = {}) {
  return {
    test_id: 'backend-only-1',
    candidate_id: CANDIDATE_ID,
    repository: 'backend',
    branch_name: 'agent/rb2-beta-backend-one',
    operator: 'BetaOperator',
    lanes: ['STAGING'],
    ...overrides
  };
}

function registration(): ReleaseBusV2RegisterInput {
  return {
    candidate_id: CANDIDATE_ID,
    repository: 'backend',
    pr_number: 1801,
    branch_name: 'agent/rb2-beta-backend-one',
    expected_head_sha: 'a'.repeat(40),
    deploy_plan: { units: ['api'], edges: [] },
    dependencies: []
  };
}

function candidate(): ReleaseBusV2CandidateRecord {
  return {
    id: CANDIDATE_ID,
    repository: 'backend',
    pr_number: 1801,
    branch_name: 'agent/rb2-beta-backend-one',
    head_sha: 'a'.repeat(40),
    requested_by: 'betaoperator',
    status: 'READY_FOR_STAGING',
    deploy_plan_json: { units: ['api'], edges: [] },
    pr_evidence_json: null,
    current_train_id: null,
    staging_validated_train_id: null,
    staging_validated_manifest_id: null,
    production_requested_at: null,
    production_requested_by: null,
    hold_reason: null,
    superseded_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1
  };
}

describe('Release Bus v2 operator-only OFF beta configuration', () => {
  const previousMode = process.env.RELEASE_BUS_V2_MODE;
  const previousAllowlist = process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;

  beforeEach(() => {
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    delete process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.RELEASE_BUS_V2_MODE;
    else process.env.RELEASE_BUS_V2_MODE = previousMode;
    if (previousAllowlist === undefined)
      delete process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
    else process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = previousAllowlist;
  });

  it('keeps global mode OFF with no implicit beta enrollment', () => {
    expect(getReleaseBusV2Mode()).toBe('OFF');
    expect(getReleaseBusV2BetaAllowlist()).toEqual([]);
  });

  it('requires exact candidate, repository, branch, actor, and lane matches', () => {
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      configuredEntry({ lanes: ['PRODUCTION', 'STAGING'] })
    ]);
    const allowlist = getReleaseBusV2BetaAllowlist();

    expect(
      releaseBusV2BetaAllowsRegistration(
        allowlist,
        registration(),
        'BETAOPERATOR'
      )
    ).toBe(true);
    expect(
      releaseBusV2BetaAllowsRegistration(
        allowlist,
        { ...registration(), branch_name: 'agent/unlisted' },
        'BETAOPERATOR'
      )
    ).toBe(false);
    expect(
      releaseBusV2BetaAllowsCandidate(allowlist, candidate(), 'STAGING')
    ).toBe(true);
    expect(
      releaseBusV2BetaAllowsCandidate(
        allowlist,
        { ...candidate(), requested_by: 'another-operator' },
        'STAGING'
      )
    ).toBe(false);
  });

  it.each([
    'not-json',
    '[]',
    JSON.stringify([configuredEntry({ candidate_id: 'not-a-uuid' })]),
    JSON.stringify([configuredEntry({ lanes: [] })]),
    JSON.stringify([configuredEntry(), configuredEntry()]),
    JSON.stringify([configuredEntry({ unexpected: true })]),
    JSON.stringify([
      configuredEntry(),
      configuredEntry({
        candidate_id: '22222222-2222-4222-8222-222222222222',
        branch_name: 'agent/rb2-beta-backend-two',
        operator: 'another-operator'
      })
    ]),
    JSON.stringify([
      configuredEntry(),
      configuredEntry({
        candidate_id: '22222222-2222-4222-8222-222222222222'
      })
    ])
  ])('fails closed for malformed allowlist %s', (value) => {
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = value;
    expect(() => getReleaseBusV2BetaAllowlist()).toThrow(
      ReleaseBusV2BetaConfigurationError
    );
    expect(getReleaseBusV2Mode()).toBe('OFF');
  });
});
