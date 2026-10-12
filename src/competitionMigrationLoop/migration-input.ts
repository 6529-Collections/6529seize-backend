import * as Joi from 'joi';

export type RemoteMigrationEnvironment = 'staging' | 'production';
export type MigrationContinuation = {
  readonly run_id: string;
  readonly started_at: number;
  readonly deadline_at: number;
};
export type MigrationLambdaInput = {
  readonly wave_id: string;
  /** Written by the Lambda when a saved migration needs another invocation. */
  readonly continuation?: MigrationContinuation;
};

const inputSchema = Joi.object<MigrationLambdaInput>({
  wave_id: Joi.string().uuid().required(),
  continuation: Joi.object({
    run_id: Joi.string().uuid().required(),
    started_at: Joi.number().integer().positive().required(),
    deadline_at: Joi.number().integer().positive().required()
  }).unknown(false)
})
  .unknown(false)
  .required();

export function parseMigrationLambdaInput(
  event: unknown
): MigrationLambdaInput {
  const result = inputSchema.validate(event, { convert: false });
  if (result.error)
    throw new Error(`Invalid migration input: ${result.error.message}`);
  return result.value;
}

export function migrationLambdaEnvironment(
  deployedEnvironment: string | undefined,
  region: string | undefined
): RemoteMigrationEnvironment {
  if (deployedEnvironment === 'staging' && region === 'eu-west-1')
    return 'staging';
  if (deployedEnvironment === 'production' && region === 'us-east-1')
    return 'production';
  throw new Error('Migration Lambda deployment and AWS region do not match');
}
