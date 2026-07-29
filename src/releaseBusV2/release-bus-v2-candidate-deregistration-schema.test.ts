import {
  ReleaseBusV2CandidateEntity,
  ReleaseBusV2LockEntity,
  ReleaseBusV2StagingStateEntity
} from '@/entities/IReleaseBusV2';
import { getMetadataArgsStorage } from 'typeorm';

function columnLength(
  target:
    | typeof ReleaseBusV2CandidateEntity
    | typeof ReleaseBusV2LockEntity
    | typeof ReleaseBusV2StagingStateEntity,
  propertyName: string
): number | undefined {
  const column = getMetadataArgsStorage().columns.find(
    (metadata) =>
      metadata.target === target && metadata.propertyName === propertyName
  );
  return typeof column?.options.length === 'number'
    ? column.options.length
    : undefined;
}

describe('Release Bus v2 logical deregistration schema compatibility', () => {
  it('fits new terminal and detached values in the existing varchar columns without DDL', () => {
    expect(columnLength(ReleaseBusV2CandidateEntity, 'status')).toBe(48);
    expect('DEREGISTERED'.length).toBeLessThanOrEqual(48);
    expect(
      columnLength(ReleaseBusV2CandidateEntity, 'staging_live_state')
    ).toBe(32);
    expect('DETACHED'.length).toBeLessThanOrEqual(32);
    expect(columnLength(ReleaseBusV2StagingStateEntity, 'status')).toBe(32);
    expect('DETACHED_MANUAL_OWNERSHIP'.length).toBeLessThanOrEqual(32);
    expect(columnLength(ReleaseBusV2LockEntity, 'lease_owner')).toBe(100);
    expect(
      `deregister:${'a'.repeat(39)}:${'0'.repeat(36)}`.length
    ).toBeLessThanOrEqual(100);
  });
});
