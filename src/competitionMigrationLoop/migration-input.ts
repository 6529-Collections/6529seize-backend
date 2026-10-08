import * as Joi from 'joi';
import { MigrationAcceptanceSchema } from '@/competitions/competition-migration-acceptance';
import type { MigrationAcceptance } from '@/competitions/competition-migration-policy';

export type RemoteMigrationEnvironment = 'staging' | 'production';
export type MigrationLambdaAction =
  | 'inspect'
  | 'migrate'
  | 'status'
  | 'readiness'
  | 'verify'
  | 'record-environment-acceptance'
  | 'reverse-reconcile'
  | 'rollback'
  | 'record-exception'
  | 'review-repair';
export type MigrationContinuation = {
  readonly run_id: string;
  readonly started_at: number;
  readonly deadline_at: number;
};
export type MigrationLambdaInput = {
  readonly environment: RemoteMigrationEnvironment;
  readonly action: MigrationLambdaAction;
  readonly wave_id?: string;
  readonly live: boolean;
  readonly operator?: string;
  readonly reason?: string;
  readonly batch: number;
  readonly auto_continue: boolean;
  readonly invocation_seconds: number;
  readonly max_duration_minutes: number;
  readonly acceptance?: MigrationAcceptance;
  readonly exception?: string;
  readonly evidence?: string;
  readonly continuation?: MigrationContinuation;
};

const inputSchema = Joi.object<MigrationLambdaInput>({
  environment: Joi.string().valid('staging', 'production').required(),
  action: Joi.string()
    .valid(
      'inspect',
      'migrate',
      'status',
      'readiness',
      'verify',
      'record-environment-acceptance',
      'reverse-reconcile',
      'rollback',
      'record-exception',
      'review-repair'
    )
    .default('inspect'),
  wave_id: Joi.when('action', {
    is: 'record-environment-acceptance',
    then: Joi.forbidden(),
    otherwise: Joi.string().uuid().required()
  }),
  live: Joi.boolean().default(false),
  operator: Joi.string().trim().min(1).max(100),
  reason: Joi.string().trim().min(1).max(2000),
  batch: Joi.number().integer().min(1).max(100).default(25),
  auto_continue: Joi.boolean().default(true),
  invocation_seconds: Joi.number().integer().min(30).max(720).default(120),
  max_duration_minutes: Joi.number().integer().min(1).max(1440).default(60),
  acceptance: Joi.when('action', {
    is: 'record-environment-acceptance',
    then: MigrationAcceptanceSchema.required(),
    otherwise: Joi.forbidden()
  }),
  exception: Joi.when('action', {
    is: 'record-exception',
    then: Joi.string()
      .pattern(/^[A-Z][A-Z_]{2,80}$/)
      .required(),
    otherwise: Joi.forbidden()
  }),
  evidence: Joi.when('action', {
    is: 'review-repair',
    then: Joi.string()
      .uri({ scheme: ['https'] })
      .max(2000)
      .required(),
    otherwise: Joi.forbidden()
  }),
  continuation: Joi.when('action', {
    is: 'migrate',
    then: Joi.object({
      run_id: Joi.string().uuid().required(),
      started_at: Joi.number().integer().positive().required(),
      deadline_at: Joi.number().integer().positive().required()
    }).unknown(false),
    otherwise: Joi.forbidden()
  })
}).unknown(false);

export function parseMigrationLambdaInput(
  event: unknown
): MigrationLambdaInput {
  const result = inputSchema.validate(event, { convert: false });
  if (result.error)
    throw new Error(`Invalid migration input: ${result.error.message}`);
  const input = result.value;
  if (input.live && (!input.operator || !input.reason))
    throw new Error('Live operations require an operator and reason');
  if (
    input.live &&
    ['inspect', 'status', 'readiness', 'verify'].includes(input.action)
  )
    throw new Error('Inspection actions must use live: false');
  if (input.continuation && (!input.live || !input.auto_continue))
    throw new Error('Continuation requires a live automatic migration');
  return input;
}

export function assertMigrationLambdaEnvironment(
  input: MigrationLambdaInput,
  deployedEnvironment: string | undefined,
  region: string | undefined
): void {
  const expectedRegion =
    input.environment === 'production' ? 'us-east-1' : 'eu-west-1';
  if (deployedEnvironment !== input.environment || region !== expectedRegion)
    throw new Error(
      'Input environment must match this Lambda deployment and AWS region'
    );
}

export function assertMigrationLambdaOperator(
  input: MigrationLambdaInput,
  operators: string | undefined
): void {
  if (
    input.live &&
    !(operators ?? '')
      .split(',')
      .map((actor) => actor.trim())
      .includes(input.operator!)
  )
    throw new Error('Operator is not allowlisted for this environment');
}
