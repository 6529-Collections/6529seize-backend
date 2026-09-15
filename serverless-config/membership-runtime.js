// Values returned here are typed before Serverless compiles CloudFormation.
// Runtime independently captures its trusted environment before loading secrets.
const configuration = Object.freeze({
  staging: Object.freeze({
    region: 'eu-west-1',
    secretArn:
      'arn:aws:secretsmanager:eu-west-1:987989283142:secret:prod/lambdas-qCUPVF'
  }),
  prod: Object.freeze({
    region: 'us-east-1',
    secretArn:
      'arn:aws:secretsmanager:us-east-1:987989283142:secret:prod/lambdas-ZDzF7a'
  })
});

/**
 * @param {{stage: unknown, region: unknown, mode?: unknown}} input
 */
function resolveRuntime(input) {
  if (input.stage !== 'staging' && input.stage !== 'prod')
    throw new Error('Unsupported membership runtime stage');
  const selected = configuration[input.stage];
  if (input.region !== selected.region)
    throw new Error('Membership runtime region does not match stage');
  const mode = input.mode === undefined ? 'inactive' : input.mode;
  if (mode !== 'inactive' && mode !== 'staging-fixture-v1')
    throw new Error('Unsupported membership runtime mode');
  if (input.stage === 'prod' && mode !== 'inactive')
    throw new Error('Production membership runtime must remain inactive');
  return Object.freeze({
    stage: input.stage,
    region: selected.region,
    secretArn: selected.secretArn,
    mode
  });
}

/**
 * @param {{stage: unknown, region: unknown, mode?: unknown, mappingEnabled?: unknown}} input
 */
function resolveWorker(input) {
  const runtime = resolveRuntime(input);
  const mapping =
    input.mappingEnabled === undefined ? 'false' : input.mappingEnabled;
  if (mapping !== 'true' && mapping !== 'false')
    throw new Error(
      'Membership worker mapping must be an exact boolean string'
    );
  if (mapping === 'true' && runtime.mode !== 'staging-fixture-v1')
    throw new Error('Membership mapping requires staging fixture mode');
  return Object.freeze({ ...runtime, mappingEnabled: mapping === 'true' });
}

/**
 * @param {{stage: unknown, region: unknown, mode?: unknown, scheduleEnabled?: unknown}} input
 */
function resolveDispatcher(input) {
  const runtime = resolveRuntime(input);
  const schedule =
    input.scheduleEnabled === undefined ? 'false' : input.scheduleEnabled;
  if (schedule !== 'true' && schedule !== 'false')
    throw new Error(
      'Membership dispatcher schedule must be an exact boolean string'
    );
  if (schedule === 'true' && runtime.mode !== 'staging-fixture-v1')
    throw new Error('Membership schedule requires staging fixture mode');
  return Object.freeze({
    ...runtime,
    scheduleEnabled: schedule === 'true',
    scheduleState: schedule === 'true' ? 'ENABLED' : 'DISABLED'
  });
}

module.exports.resolveWorker = resolveWorker;
module.exports.worker = async ({ options, resolveVariable }) =>
  resolveWorker({
    stage: options.stage ?? (await resolveVariable('self:provider.stage')),
    region: options.region ?? (await resolveVariable('self:provider.region')),
    mode: process.env.MEMBERSHIP_RUNTIME_MODE,
    mappingEnabled: process.env.MEMBERSHIP_WORKER_MAPPING_ENABLED
  });

module.exports.resolveDispatcher = resolveDispatcher;
module.exports.dispatcher = async ({ options, resolveVariable }) =>
  resolveDispatcher({
    stage: options.stage ?? (await resolveVariable('self:provider.stage')),
    region: options.region ?? (await resolveVariable('self:provider.region')),
    mode: process.env.MEMBERSHIP_RUNTIME_MODE,
    scheduleEnabled: process.env.MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED
  });
