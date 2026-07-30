import {
  ApiReleaseBusV2CandidateDeregistrationExecuteRequest,
  ApiReleaseBusV2CandidateDeregistrationExecuteRequestPhaseEnum
} from '@/api/generated/models/ApiReleaseBusV2CandidateDeregistrationExecuteRequest';
import {
  ApiReleaseBusV2CandidateDeregistrationCommittedError,
  ApiReleaseBusV2CandidateDeregistrationCommittedErrorOutcomeEnum,
  ApiReleaseBusV2CandidateDeregistrationCommittedErrorPhysicalStagingPresenceEnum
} from '@/api/generated/models/ApiReleaseBusV2CandidateDeregistrationCommittedError';
import { ApiReleaseBusV2CandidateDeregistrationError } from '@/api/generated/models/ApiReleaseBusV2CandidateDeregistrationError';
import {
  ApiReleaseBusV2CandidateDeregistrationUncommittedError,
  ApiReleaseBusV2CandidateDeregistrationUncommittedErrorOutcomeEnum,
  ApiReleaseBusV2CandidateDeregistrationUncommittedErrorPhysicalStagingPresenceEnum
} from '@/api/generated/models/ApiReleaseBusV2CandidateDeregistrationUncommittedError';
import { ApiReleaseBusV2CandidateDeregistrationPrepareRequestPhaseEnum } from '@/api/generated/models/ApiReleaseBusV2CandidateDeregistrationPrepareRequest';
import { ApiReleaseBusV2CandidateDeregistrationResponsePhysicalStagingPresenceEnum } from '@/api/generated/models/ApiReleaseBusV2CandidateDeregistrationResponse';
import { ReleaseBusV2CandidateStagingLiveStateEnum } from '@/api/generated/models/ReleaseBusV2Candidate';
import { ReleaseBusV2CandidateStatus } from '@/api/generated/models/ReleaseBusV2CandidateStatus';
import { ReleaseBusV2StagingStateStatusEnum } from '@/api/generated/models/ReleaseBusV2StagingState';
import { ObjectSerializer } from '@/api/generated/models/ObjectSerializer';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Release Bus v2 logical deregistration generated contract', () => {
  it('publishes all terminal/detached literals through generated models', () => {
    type ExecuteCasKeys =
      | 'expected_plan_sha256'
      | 'expected_inventory_sha256'
      | 'expected_candidates'
      | 'expected_controls'
      | 'expected_locks'
      | 'expected_staging_state_row_version'
      | 'expected_staging_refs';
    type ExecuteCasFieldsAreRequired =
      Pick<
        ApiReleaseBusV2CandidateDeregistrationExecuteRequest,
        ExecuteCasKeys
      > extends Required<
        Pick<
          ApiReleaseBusV2CandidateDeregistrationExecuteRequest,
          ExecuteCasKeys
        >
      >
        ? true
        : false;
    const executeCasFieldsAreRequired: ExecuteCasFieldsAreRequired = true;

    expect(executeCasFieldsAreRequired).toBe(true);
    expect(ReleaseBusV2CandidateStatus.Deregistered).toBe('DEREGISTERED');
    expect(ReleaseBusV2CandidateStagingLiveStateEnum.Detached).toBe('DETACHED');
    expect(ReleaseBusV2StagingStateStatusEnum.DetachedManualOwnership).toBe(
      'DETACHED_MANUAL_OWNERSHIP'
    );
    expect(
      ApiReleaseBusV2CandidateDeregistrationPrepareRequestPhaseEnum.Prepare
    ).toBe('PREPARE');
    expect(
      ApiReleaseBusV2CandidateDeregistrationExecuteRequestPhaseEnum.Execute
    ).toBe('EXECUTE');
    expect(
      ApiReleaseBusV2CandidateDeregistrationExecuteRequest.attributeTypeMap
        .filter(({ name }) => name.startsWith('expected_'))
        .map(({ name }) => name)
    ).toHaveLength(7);
    expect(
      ApiReleaseBusV2CandidateDeregistrationResponsePhysicalStagingPresenceEnum.Detached
    ).toBe('UNKNOWN_DETACHED');
    expect(
      ObjectSerializer.findCorrectType(
        { phase: 'PREPARE' },
        'ApiReleaseBusV2CandidateDeregistrationRequest'
      )
    ).toBe('ApiReleaseBusV2CandidateDeregistrationPrepareRequest');
  });

  it.each([
    {
      outcome:
        ApiReleaseBusV2CandidateDeregistrationUncommittedErrorOutcomeEnum.NotCommitted,
      error: 'The exact safety fence changed before commit',
      committed: false,
      physical_staging_presence:
        ApiReleaseBusV2CandidateDeregistrationUncommittedErrorPhysicalStagingPresenceEnum.UnknownUnchanged
    },
    {
      outcome:
        ApiReleaseBusV2CandidateDeregistrationCommittedErrorOutcomeEnum.Committed,
      error: 'The inventory committed before lock cleanup failed',
      committed: true,
      deregistration_id: '123e4567-e89b-42d3-a456-426614174001',
      physical_staging_presence:
        ApiReleaseBusV2CandidateDeregistrationCommittedErrorPhysicalStagingPresenceEnum.UnknownDetached
    }
  ] satisfies readonly ApiReleaseBusV2CandidateDeregistrationError[])(
    'round-trips committed=$committed error evidence through the generated serializer',
    (evidence) => {
      const serialized = ObjectSerializer.serialize(
        evidence,
        'ApiReleaseBusV2CandidateDeregistrationError',
        ''
      );
      const deserialized = ObjectSerializer.deserialize(
        serialized,
        'ApiReleaseBusV2CandidateDeregistrationError',
        ''
      );

      expect(serialized).toEqual(evidence);
      expect(deserialized).toMatchObject(evidence);
      const expectedType =
        evidence.outcome ===
        ApiReleaseBusV2CandidateDeregistrationCommittedErrorOutcomeEnum.Committed
          ? 'ApiReleaseBusV2CandidateDeregistrationCommittedError'
          : 'ApiReleaseBusV2CandidateDeregistrationUncommittedError';
      expect(
        ObjectSerializer.findCorrectType(
          evidence,
          'ApiReleaseBusV2CandidateDeregistrationError'
        )
      ).toBe(expectedType);
      expect(
        evidence.outcome ===
          ApiReleaseBusV2CandidateDeregistrationCommittedErrorOutcomeEnum.Committed
          ? ApiReleaseBusV2CandidateDeregistrationCommittedError.getAttributeTypeMap()
          : ApiReleaseBusV2CandidateDeregistrationUncommittedError.getAttributeTypeMap()
      ).toHaveLength(evidence.committed ? 5 : 4);
    }
  );

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
    expect(schemas.match(/oneOf:/g)).toHaveLength(2);
    expect(schemas).toContain('propertyName: phase');
    expect(schemas).toContain('propertyName: outcome');
    expect(schemas).toMatch(
      /ApiReleaseBusV2CandidateDeregistrationError:\n\s+oneOf:/
    );
    expect(schemas).toMatch(
      /ApiReleaseBusV2CandidateDeregistrationCommittedError:\n\s+type: object/
    );
    expect(schemas).toMatch(
      /ApiReleaseBusV2CandidateDeregistrationUncommittedError:\n\s+type: object/
    );
    expect(schemas).toMatch(
      /expected_candidates:\n\s+type: array[\s\S]*?\n\s+minItems: 0/
    );
    expect(schemas).toMatch(
      /candidate_count:\n\s+type: integer\n\s+minimum: 0/
    );
    expect(schemas).toMatch(/candidates:\n\s+type: array\n\s+minItems: 0/);
  });
});
