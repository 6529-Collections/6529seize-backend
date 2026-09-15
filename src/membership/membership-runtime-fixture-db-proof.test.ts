import type { SqlExecutor } from '@/sql-executor';
import {
  MembershipFixtureDbProof,
  membershipFixtureDbProofReport,
  membershipFixtureDbProofSchema
} from './membership-runtime-fixture-db-proof.types';
import { MembershipFixtureDbProofService } from './membership-runtime-fixture-db-proof';

const uuid = '01234567-89ab-4cde-8fab-0123456789ab';
const otherUuid = '11234567-89ab-4cde-8fab-0123456789ab';
const waiting: MembershipFixtureDbProof = {
  protocol_version: 1,
  phase: 'LEASE_WAIT',
  owner: { request_id: uuid, expires_at_millis: '900000' },
  lease: {
    run_id: uuid,
    checkpoint_version: '0',
    lease_token: otherUuid,
    claimed_at_millis: '0',
    expires_at_millis: '90000',
    request_version: '1',
    successor_checkpoint_version: null,
    checkpoint_fenced: false,
    completion_fenced: false,
    failure_fenced: false
  },
  gc: null,
  completed_at_millis: null,
  interruption: null
};
const done: MembershipFixtureDbProof = {
  ...waiting,
  phase: 'DONE',
  owner: null,
  lease: {
    ...waiting.lease,
    lease_token: null,
    successor_checkpoint_version: '1',
    checkpoint_fenced: true,
    completion_fenced: true,
    failure_fenced: true
  },
  gc: {
    old_run_id: uuid,
    request_version: '2',
    new_run_id: otherUuid,
    member_count: 29,
    member_hash: 'a'.repeat(64),
    reader_connection_id: '7',
    writer_connection_id: '8',
    reader_verified_at_millis: '100000',
    retired_at_millis: '99000',
    eligible_at_millis: '219000',
    deleted_count: 29
  },
  completed_at_millis: '220000'
};

describe('closed membership database proof receipts', () => {
  it('retains the real private claim and bounded completed evidence', () => {
    expect(membershipFixtureDbProofSchema.parse(waiting)).toEqual(waiting);
    expect(membershipFixtureDbProofSchema.parse(done)).toEqual(done);
  });

  it.each([
    { ...waiting, unknown: true },
    { ...waiting, phase: 'DONE' },
    { ...waiting, lease: { ...waiting.lease, lease_token: null } },
    { ...waiting, lease: { ...waiting.lease, checkpoint_fenced: true } },
    { ...waiting, lease: { ...waiting.lease, expires_at_millis: '89999' } },
    { ...done, lease: { ...done.lease, lease_token: uuid } },
    { ...done, lease: { ...done.lease, successor_checkpoint_version: '0' } },
    { ...done, gc: { ...done.gc, reader_connection_id: '8' } },
    { ...done, gc: { ...done.gc, new_run_id: uuid } },
    { ...done, gc: { ...done.gc, member_count: 37 } },
    { ...done, gc: { ...done.gc, deleted_count: 28 } },
    { ...done, gc: { ...done.gc, eligible_at_millis: '218999' } },
    { ...done, gc: { ...done.gc, reader_verified_at_millis: '219000' } },
    { ...done, completed_at_millis: null },
    { ...waiting, interruption: 'READER_OVERLAP_LOST' }
  ])('rejects contradictory or widened receipt %#', (value) => {
    expect(() => membershipFixtureDbProofSchema.parse(value)).toThrow();
  });

  it('returns capability-free DB-only evidence', () => {
    const report = membershipFixtureDbProofReport(waiting);
    expect(report.evidence_kind).toBe('DATABASE_ONLY');
    expect(report).not.toHaveProperty('owner');
    expect(report.lease).not.toHaveProperty('lease_token');
    expect(JSON.stringify(report)).not.toContain(otherUuid);
    expect(waiting.lease.lease_token).toBe(otherUuid);
  });
});

describe('database proof preconnection admission', () => {
  const transaction = jest.fn();
  const db = {
    executeNativeQueriesInTransaction: transaction
  } as unknown as SqlExecutor;
  beforeEach(() => transaction.mockReset());

  it.each([
    { stage: 'prod', region: 'us-east-1' },
    { stage: 'staging', region: 'us-east-1' },
    { stage: 'development', region: 'eu-west-1' }
  ])('rejects environment %p before DB access', async (environment) => {
    await expect(
      new MembershipFixtureDbProofService(db, environment).run({
        awsRequestId: uuid,
        getRemainingTimeInMillis: () => 900000
      })
    ).rejects.toThrow('staging eu-west-1');
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([179999, Number.NaN, Number.POSITIVE_INFINITY, 900001])(
    'rejects an invalid outer deadline %p before DB access',
    async (remaining) => {
      await expect(
        new MembershipFixtureDbProofService(db, {
          stage: 'staging',
          region: 'eu-west-1'
        }).run({
          awsRequestId: uuid,
          getRemainingTimeInMillis: () => remaining
        })
      ).rejects.toThrow('bounded fixture');
      expect(transaction).not.toHaveBeenCalled();
    }
  );
});
