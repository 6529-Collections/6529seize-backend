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
 * @param {{stage: unknown, region: unknown, mode?: unknown, mappingEnabled?: unknown}} input
 */
function resolveWorker(input) {
  if (input.stage !== 'staging' && input.stage !== 'prod')
    throw new Error('Unsupported membership runtime stage');
  const selected = configuration[input.stage];
  if (input.region !== selected.region)
    throw new Error('Membership runtime region does not match stage');
  const mode = input.mode === undefined ? 'inactive' : input.mode;
  const mapping =
    input.mappingEnabled === undefined ? 'false' : input.mappingEnabled;
  if (mode !== 'inactive' && mode !== 'staging-fixture-v1')
    throw new Error('Unsupported membership runtime mode');
  if (mapping !== 'true' && mapping !== 'false')
    throw new Error(
      'Membership worker mapping must be an exact boolean string'
    );
  if (input.stage === 'prod' && mode !== 'inactive')
    throw new Error('Production membership runtime must remain inactive');
  if (mapping === 'true' && mode !== 'staging-fixture-v1')
    throw new Error('Membership mapping requires staging fixture mode');
  return Object.freeze({
    stage: input.stage,
    region: selected.region,
    secretArn: selected.secretArn,
    mode,
    mappingEnabled: mapping === 'true'
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
