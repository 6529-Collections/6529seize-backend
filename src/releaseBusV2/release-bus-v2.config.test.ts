import {
  deriveReleaseBusV2LaneStates,
  getReleaseBusV2BetaAllowlist,
  getReleaseBusV2Mode,
  releaseBusV2BetaAllowsCandidate,
  releaseBusV2BetaAllowsLaneInMode,
  releaseBusV2BetaAllowsRegistration,
  releaseBusV2BetaInfrastructureFailureInjection,
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
    production_selection_id: null,
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

  it('keeps a STAGING-mode beta confined to the production lane', () => {
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      configuredEntry({ lanes: ['PRODUCTION'] })
    ]);
    const allowlist = getReleaseBusV2BetaAllowlist();

    expect(
      releaseBusV2BetaAllowsLaneInMode('STAGING', allowlist, 'PRODUCTION')
    ).toBe(true);
    expect(
      releaseBusV2BetaAllowsLaneInMode('STAGING', allowlist, 'STAGING')
    ).toBe(false);
    expect(
      releaseBusV2BetaAllowsLaneInMode('PRODUCTION', allowlist, 'PRODUCTION')
    ).toBe(false);
  });

  it('binds one staging-only infrastructure injection to an exact candidate', () => {
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      configuredEntry({
        inject_infrastructure_failure_operation: 'PREPARE_ARTIFACT_BACKEND'
      })
    ]);
    const allowlist = getReleaseBusV2BetaAllowlist();

    expect(
      releaseBusV2BetaInfrastructureFailureInjection(
        allowlist,
        [candidate()],
        'STAGING',
        'PREPARE_ARTIFACT_BACKEND'
      )
    ).toEqual({ candidateId: CANDIDATE_ID, testId: 'backend-only-1' });
    expect(
      releaseBusV2BetaInfrastructureFailureInjection(
        allowlist,
        [candidate()],
        'PRODUCTION',
        'PREPARE_ARTIFACT_BACKEND'
      )
    ).toBeNull();
    expect(
      releaseBusV2BetaInfrastructureFailureInjection(
        allowlist,
        [{ ...candidate(), id: '22222222-2222-4222-8222-222222222222' }],
        'STAGING',
        'PREPARE_ARTIFACT_BACKEND'
      )
    ).toBeNull();
  });

  it.each([
    'not-json',
    '[]',
    JSON.stringify([configuredEntry({ candidate_id: 'not-a-uuid' })]),
    JSON.stringify([configuredEntry({ lanes: [] })]),
    JSON.stringify([configuredEntry(), configuredEntry()]),
    JSON.stringify([configuredEntry({ unexpected: true })]),
    JSON.stringify([
      configuredEntry({
        inject_infrastructure_failure_operation: 'PREPARE_ARTIFACT_FRONTEND'
      })
    ]),
    JSON.stringify([
      configuredEntry({
        inject_infrastructure_failure_operation: 'PREPARE_ARTIFACT_BACKEND',
        lanes: ['PRODUCTION']
      })
    ]),
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
    ]),
    JSON.stringify([
      configuredEntry({
        inject_infrastructure_failure_operation: 'PREPARE_ARTIFACT_BACKEND'
      }),
      configuredEntry({
        candidate_id: '22222222-2222-4222-8222-222222222222',
        branch_name: 'agent/rb2-beta-backend-two',
        inject_infrastructure_failure_operation: 'PREPARE_ARTIFACT_BACKEND'
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

describe('deriveReleaseBusV2LaneStates', () => {
  const runningControls = [
    {
      scope: 'ALL' as const,
      paused: false,
      reason: 'Global recovery complete'
    },
    {
      scope: 'STAGING' as const,
      paused: false,
      reason: 'Staging enabled'
    },
    {
      scope: 'PRODUCTION' as const,
      paused: false,
      reason: 'Production enabled'
    }
  ];

  it('exposes only the two effective automation lanes', () => {
    expect(deriveReleaseBusV2LaneStates('PRODUCTION', runningControls)).toEqual(
      [
        {
          lane: 'STAGING',
          status: 'ON',
          changeable: true,
          reason: 'Staging enabled'
        },
        {
          lane: 'PRODUCTION',
          status: 'ON',
          changeable: true,
          reason: 'Production enabled'
        }
      ]
    );
  });

  it('derives an individual lane off state from its control', () => {
    expect(
      deriveReleaseBusV2LaneStates('PRODUCTION', [
        ...runningControls.filter(({ scope }) => scope !== 'PRODUCTION'),
        {
          scope: 'PRODUCTION',
          paused: true,
          reason: 'Production maintenance'
        }
      ])
    ).toEqual([
      {
        lane: 'STAGING',
        status: 'ON',
        changeable: true,
        reason: 'Staging enabled'
      },
      {
        lane: 'PRODUCTION',
        status: 'OFF',
        changeable: true,
        reason: 'Production maintenance'
      }
    ]);
  });

  it('derives both lanes off from the internal emergency fence', () => {
    expect(
      deriveReleaseBusV2LaneStates('PRODUCTION', [
        {
          scope: 'ALL',
          paused: true,
          reason: 'Emergency hard stop'
        },
        ...runningControls.filter(({ scope }) => scope !== 'ALL')
      ])
    ).toEqual([
      {
        lane: 'STAGING',
        status: 'OFF',
        changeable: false,
        reason: 'Emergency hard stop'
      },
      {
        lane: 'PRODUCTION',
        status: 'OFF',
        changeable: false,
        reason: 'Emergency hard stop'
      }
    ]);
  });

  it('keeps the internal capability ceiling fail-closed', () => {
    expect(deriveReleaseBusV2LaneStates('STAGING', runningControls)).toEqual([
      {
        lane: 'STAGING',
        status: 'ON',
        changeable: true,
        reason: 'Staging enabled'
      },
      {
        lane: 'PRODUCTION',
        status: 'OFF',
        changeable: false,
        reason: 'Internal Release Bus hard stop is active'
      }
    ]);
    expect(deriveReleaseBusV2LaneStates('OFF', runningControls)).toEqual([
      {
        lane: 'STAGING',
        status: 'OFF',
        changeable: false,
        reason: 'Internal Release Bus hard stop is active'
      },
      {
        lane: 'PRODUCTION',
        status: 'OFF',
        changeable: false,
        reason: 'Internal Release Bus hard stop is active'
      }
    ]);
  });

  it('fails closed when an internal control is missing or duplicated', () => {
    expect(() =>
      deriveReleaseBusV2LaneStates(
        'PRODUCTION',
        runningControls.filter(({ scope }) => scope !== 'ALL')
      )
    ).toThrow('ALL control is unavailable');
    expect(() =>
      deriveReleaseBusV2LaneStates('PRODUCTION', [
        ...runningControls,
        runningControls[0]
      ])
    ).toThrow('ALL control is unavailable');
  });
});
