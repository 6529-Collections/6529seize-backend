import { MEMBERSHIP_FIXTURE_CLEANUP_TABLES } from './membership-runtime-fixture-control-layout';
import { Column, Entity, PrimaryColumn } from 'typeorm';
import { z } from 'zod';
import { SqlExecutor } from '@/sql-executor';
import {
  membershipQueryOptions,
  MembershipPrimaryContext
} from './membership-primary';
import {
  MEMBERSHIP_DB_NOW,
  timeMembershipOperation
} from './membership-repository.utils';
import { normalizeCounter } from './membership-validation';
import {
  fixtureCounter as counter,
  fixtureProofSchema,
  validateFixtureProof
} from './membership-runtime-fixture-proof';
import {
  MEMBERSHIP_FIXTURE_CONTROL_TABLE,
  MEMBERSHIP_FIXTURE_DATABASE,
  MEMBERSHIP_FIXTURE_OWNER
} from './membership-runtime-policy';

/** Fixture infrastructure only. Deliberately absent from the production entity barrel. */
@Entity(MEMBERSHIP_FIXTURE_CONTROL_TABLE)
export class MembershipFixtureControlEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, collation: 'utf8_bin' })
  readonly id!: string;
  @Column({ type: 'int' }) readonly protocol_version!: number;
  @Column({ type: 'char', length: 64 }) readonly manifest_hash!: string;
  @Column({ type: 'bigint' }) readonly revision!: string;
  @Column({ type: 'json' }) readonly state_json!: unknown;
  @Column({ type: 'bigint' }) readonly created_at_millis!: string;
  @Column({ type: 'bigint' }) readonly updated_at_millis!: string;
}
const fixtureState = z
  .object({
    setup_stage: z.enum([
      'SCHEMA_READY',
      'PROVISIONED',
      'INPUTS_READY',
      'CATALOGUED',
      'READY',
      'CLEANING',
      'CLEANED'
    ]),
    input_page: z.number().int().min(0).max(3),
    anchor_millis: counter,
    cleanup_not_before_millis: counter.optional(),
    cleanup_table: z
      .number()
      .int()
      .min(0)
      .max(MEMBERSHIP_FIXTURE_CLEANUP_TABLES.length)
      .optional(),
    scenario: z.enum([
      'BASELINE',
      'MISSED_WAKEUP',
      'SOURCE_CHANGE',
      'EXPIRY_WAIT',
      'BOUNDARY_CAPTURED',
      'GRANT_ACTIVE',
      'GRANT_DISABLED',
      'EMPTY',
      'IDENTITY_MISSING',
      'FANOUT_WAIT',
      'FANOUT_CAPTURED',
      'IDENTITY_RECOVERED',
      'TRANSPORT_CORRECTED'
    ]),
    proof: fixtureProofSchema.optional(),
    dispatch_send_failure: z
      .object({
        requested_version: counter,
        reserved_until_millis: counter
      })
      .strict()
      .optional(),
    transport: z
      .object({
        phase: z.enum(['HELD', 'CORRECTED']),
        message_id: z.string().uuid(),
        run_id: z.string().uuid(),
        checkpoint_version: counter
      })
      .strict()
      .nullable()
  })
  .strict();
export type FixtureState = z.infer<typeof fixtureState>;
export interface FixtureControl {
  readonly revision: string;
  readonly manifest_hash: string;
  readonly state: FixtureState;
}
export function parseFixtureState(value: unknown): FixtureState {
  const encoded = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 16384)
    throw new Error('Fixture control state exceeds limit');
  const state = fixtureState.parse(JSON.parse(encoded));
  if (state.proof) validateFixtureProof(state.proof);
  validateScenarioProof(state);
  if (
    (state.cleanup_table === undefined) !==
    (state.cleanup_not_before_millis === undefined)
  )
    throw new Error('Incomplete fixture cleanup state');
  if (
    (state.setup_stage === 'CLEANING' || state.setup_stage === 'CLEANED') !==
    (state.cleanup_table !== undefined &&
      state.cleanup_not_before_millis !== undefined)
  )
    throw new Error('Invalid fixture cleanup progress');
  if (
    state.setup_stage === 'CLEANED' &&
    state.cleanup_table !== MEMBERSHIP_FIXTURE_CLEANUP_TABLES.length
  )
    throw new Error('Incomplete fixture cleanup');
  if (
    state.setup_stage === 'CLEANING' &&
    state.cleanup_table === MEMBERSHIP_FIXTURE_CLEANUP_TABLES.length
  )
    throw new Error('Invalid completed cleanup phase');
  if (state.setup_stage === 'SCHEMA_READY' && state.input_page !== 0)
    throw new Error('Invalid initial fixture page');
  if (state.setup_stage === 'PROVISIONED' && state.input_page >= 3)
    throw new Error('Invalid pending fixture page');
  if (
    !['SCHEMA_READY', 'PROVISIONED'].includes(state.setup_stage) &&
    state.input_page !== 3
  )
    throw new Error('Incomplete fixture inputs');
  return state;
}
function validateScenarioProof(state: FixtureState): void {
  const proof = state.proof;
  const required: Partial<Record<FixtureState['scenario'], boolean>> = {
    SOURCE_CHANGE: !!proof?.source_change,
    EXPIRY_WAIT: !!proof?.boundary && proof.boundary.captured === null,
    BOUNDARY_CAPTURED: !!proof?.boundary?.captured,
    GRANT_ACTIVE: !!proof?.boundary?.false_publication_run_id,
    GRANT_DISABLED: !!proof?.boundary?.false_publication_run_id,
    EMPTY: !!proof?.boundary?.false_publication_run_id,
    IDENTITY_MISSING: !!proof?.identity_retry,
    FANOUT_WAIT: !!proof?.fanout && proof.fanout.captured === null,
    FANOUT_CAPTURED: !!proof?.fanout?.captured,
    IDENTITY_RECOVERED: !!proof?.fanout?.captured?.completed_observed_at_millis
  };
  if (required[state.scenario] === false)
    throw new Error('Fixture scenario is missing its durable proof');
}
export async function assertMembershipFixtureDatabase(
  db: SqlExecutor,
  ctx: MembershipPrimaryContext
): Promise<void> {
  const selected = await db.execute<{ selected_database: string | null }>(
    'SELECT DATABASE() AS selected_database',
    undefined,
    membershipQueryOptions(ctx)
  );
  if (
    selected.length !== 1 ||
    selected[0].selected_database !== MEMBERSHIP_FIXTURE_DATABASE
  )
    throw new Error('Membership fixture database selection mismatch');
}
export class MembershipFixtureControlDb {
  constructor(private readonly db: SqlExecutor) {}
  async read(
    ctx: MembershipPrimaryContext,
    lock = false
  ): Promise<FixtureControl | null> {
    return timeMembershipOperation(
      'MembershipFixtureControlDb->read',
      ctx,
      async () => {
        await assertMembershipFixtureDatabase(this.db, ctx);
        const rows = await this.db.execute<{
          id: string;
          protocol_version: number | string;
          manifest_hash: string;
          revision: string;
          state_json: unknown;
        }>(
          `SELECT id, protocol_version, manifest_hash, CAST(revision AS CHAR) revision, LEFT(CAST(state_json AS CHAR),16385) state_json FROM ${MEMBERSHIP_FIXTURE_CONTROL_TABLE} WHERE id=:id LIMIT 2 ${lock ? 'FOR UPDATE' : ''}`,
          { id: MEMBERSHIP_FIXTURE_OWNER },
          membershipQueryOptions(ctx)
        );
        if (!rows.length) return null;
        const row = rows[0];
        if (
          rows.length !== 1 ||
          row.id !== MEMBERSHIP_FIXTURE_OWNER ||
          String(row.protocol_version) !== '1' ||
          !/^[a-f0-9]{64}$/.test(row.manifest_hash)
        )
          throw new Error('Invalid fixture ownership marker');
        return {
          revision: normalizeCounter(row.revision),
          manifest_hash: row.manifest_hash,
          state: parseFixtureState(row.state_json)
        };
      }
    );
  }
  async initialize(
    manifestHash: string,
    ctx: MembershipPrimaryContext
  ): Promise<FixtureControl> {
    return timeMembershipOperation(
      'MembershipFixtureControlDb->initialize',
      ctx,
      async () => {
        const existing = await this.read(ctx, true);
        if (existing) {
          if (existing.manifest_hash !== manifestHash)
            throw new Error('Fixture manifest mismatch');
          return existing;
        }
        if (!/^[a-f0-9]{64}$/.test(manifestHash))
          throw new Error('Invalid fixture manifest');
        const rows = await this.db.execute<{ now: string }>(
          `SELECT CAST(${MEMBERSHIP_DB_NOW} AS CHAR) now`,
          undefined,
          membershipQueryOptions(ctx)
        );
        const state: FixtureState = {
          setup_stage: 'SCHEMA_READY',
          input_page: 0,
          anchor_millis: normalizeCounter(rows[0]?.now),
          scenario: 'BASELINE',
          transport: null
        };
        await this.db.execute(
          `INSERT INTO ${MEMBERSHIP_FIXTURE_CONTROL_TABLE} (id,protocol_version,manifest_hash,revision,state_json,created_at_millis,updated_at_millis) VALUES (:id,1,:hash,0,:state,${MEMBERSHIP_DB_NOW},${MEMBERSHIP_DB_NOW})`,
          {
            id: MEMBERSHIP_FIXTURE_OWNER,
            hash: manifestHash,
            state: JSON.stringify(state)
          },
          membershipQueryOptions(ctx)
        );
        return { revision: '0', manifest_hash: manifestHash, state };
      }
    );
  }
  async update(
    expectedRevision: string,
    state: FixtureState,
    ctx: MembershipPrimaryContext
  ): Promise<FixtureControl> {
    return timeMembershipOperation(
      'MembershipFixtureControlDb->update',
      ctx,
      async () => {
        const current = await this.read(ctx, true);
        if (!current || current.revision !== normalizeCounter(expectedRevision))
          throw new Error('Fixture control revision conflict');
        const parsed = parseFixtureState(state);
        if (parsed.anchor_millis !== current.state.anchor_millis)
          throw new Error('Fixture anchor is immutable');
        const revision = normalizeCounter(BigInt(current.revision) + BigInt(1));
        await this.db.execute(
          `UPDATE ${MEMBERSHIP_FIXTURE_CONTROL_TABLE} SET revision=:revision,state_json=:state,updated_at_millis=${MEMBERSHIP_DB_NOW} WHERE id=:id AND revision=:expected`,
          {
            id: MEMBERSHIP_FIXTURE_OWNER,
            revision,
            expected: current.revision,
            state: JSON.stringify(parsed)
          },
          membershipQueryOptions(ctx)
        );
        return { ...current, revision, state: parsed };
      }
    );
  }
}
