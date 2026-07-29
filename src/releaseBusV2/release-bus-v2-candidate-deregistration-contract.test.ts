import { ApiReleaseBusV2CandidateDeregistrationRequestPhaseEnum } from '@/api/generated/models/ApiReleaseBusV2CandidateDeregistrationRequest';
import { ApiReleaseBusV2CandidateDeregistrationResponsePhysicalStagingPresenceEnum } from '@/api/generated/models/ApiReleaseBusV2CandidateDeregistrationResponse';
import { ReleaseBusV2CandidateStagingLiveStateEnum } from '@/api/generated/models/ReleaseBusV2Candidate';
import { ReleaseBusV2CandidateStatus } from '@/api/generated/models/ReleaseBusV2CandidateStatus';
import { ReleaseBusV2StagingStateStatusEnum } from '@/api/generated/models/ReleaseBusV2StagingState';
import { ObjectSerializer } from '@/api/generated/models/ObjectSerializer';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Release Bus v2 logical deregistration generated contract', () => {
  it('publishes all terminal/detached literals through generated models', () => {
    expect(ReleaseBusV2CandidateStatus.Deregistered).toBe('DEREGISTERED');
    expect(ReleaseBusV2CandidateStagingLiveStateEnum.Detached).toBe('DETACHED');
    expect(ReleaseBusV2StagingStateStatusEnum.DetachedManualOwnership).toBe(
      'DETACHED_MANUAL_OWNERSHIP'
    );
    expect(ApiReleaseBusV2CandidateDeregistrationRequestPhaseEnum.Prepare).toBe(
      'PREPARE'
    );
    expect(
      ApiReleaseBusV2CandidateDeregistrationResponsePhysicalStagingPresenceEnum.Detached
    ).toBe('UNKNOWN_DETACHED');
    expect(
      ObjectSerializer.findCorrectType(
        { phase: 'PREPARE' },
        'ApiReleaseBusV2CandidateDeregistrationRequest'
      )
    ).toBe('ApiReleaseBusV2CandidateDeregistrationRequest');
  });

  it('keeps the operator route manual while OpenAPI declares strict unique CAS inventories', () => {
    const openapi = readFileSync(
      path.join(__dirname, '../api-serverless/openapi.yaml'),
      'utf8'
    );
    const route = openapi.slice(
      openapi.indexOf(
        '/deploy/release-bus-v2/maintenance/deregister-all-candidates:'
      ),
      openapi.indexOf(
        '/subscriptions/consolidation/coverage/{consolidation_key}:'
      )
    );
    const schemas = openapi.slice(
      openapi.indexOf(
        'ApiReleaseBusV2CandidateDeregistrationCandidateVersion:'
      ),
      openapi.indexOf('ApiRepCategoriesPage:')
    );

    expect(route).toContain('Operator-only');
    expect(route).not.toContain('x-6529-router');
    expect(schemas.match(/uniqueItems: true/g)).toHaveLength(3);
    expect(schemas).toContain('additionalProperties: false');
    expect(schemas).toContain('PREPARE accepts only phase and reason');
  });
});
