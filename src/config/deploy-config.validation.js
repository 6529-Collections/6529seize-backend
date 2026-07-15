const DEPLOY_ENVIRONMENTS = ['staging', 'prod'];
const DEPLOY_SERVICE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEPLOY_ADAPTERS = [
  'serverless',
  'resources-only',
  'api-zip',
  'direct-lambda-zip',
  'special-script'
];
const DEPLOY_VALIDATION_PROFILES = [
  'lambda-version',
  'api-health',
  'cloudformation-stack',
  'lambda-edge-association'
];

function isDeployEnvironment(value) {
  return DEPLOY_ENVIRONMENTS.includes(value);
}

function validateDeployServiceConfig(service, seenNames) {
  if (!service || typeof service !== 'object') {
    throw new Error('each service must be an object');
  }

  if (typeof service.name !== 'string' || service.name.trim() === '') {
    throw new Error('each service must have a non-empty name');
  }

  if (!DEPLOY_SERVICE_NAME_PATTERN.test(service.name)) {
    throw new Error(
      `service ${service.name} has invalid name; only letters, numbers, "_" and "-" are allowed`
    );
  }

  if (seenNames.has(service.name)) {
    throw new Error(`duplicate deploy service: ${service.name}`);
  }
  seenNames.add(service.name);

  if (
    !Array.isArray(service.allowed_environments) ||
    service.allowed_environments.length === 0
  ) {
    throw new Error(`service ${service.name} must have allowed_environments`);
  }

  for (const environment of service.allowed_environments) {
    if (!isDeployEnvironment(environment)) {
      throw new Error(
        `service ${service.name} has invalid environment ${environment}`
      );
    }
  }

  if (!DEPLOY_ADAPTERS.includes(service.deploy_adapter)) {
    throw new Error(`service ${service.name} has invalid deploy_adapter`);
  }
  if (!service.aws_region || typeof service.aws_region !== 'object') {
    throw new Error(`service ${service.name} must define aws_region`);
  }
  for (const environment of service.allowed_environments) {
    if (typeof service.aws_region[environment] !== 'string') {
      throw new Error(
        `service ${service.name} must define aws_region.${environment}`
      );
    }
  }
  if (!Array.isArray(service.verification_targets)) {
    throw new Error(`service ${service.name} must define verification_targets`);
  }
  if (!DEPLOY_VALIDATION_PROFILES.includes(service.validation_profile))
    throw new Error(`service ${service.name} has invalid validation_profile`);
  if (!['allowed', 'production-only'].includes(service.staging_policy)) {
    throw new Error(`service ${service.name} has invalid staging_policy`);
  }
  if (!Array.isArray(service.default_dependencies)) {
    throw new Error(`service ${service.name} must define default_dependencies`);
  }
  if (typeof service.automatic_rollback_supported !== 'boolean') {
    throw new Error(
      `service ${service.name} must define automatic_rollback_supported`
    );
  }
}

function validateDeployConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('deploy-services.json must contain an object');
  }

  const {
    default_environment: defaultEnvironment,
    default_service: defaultService,
    services
  } = config;

  if (!isDeployEnvironment(defaultEnvironment)) {
    throw new Error('default_environment must be staging or prod');
  }

  if (typeof defaultService !== 'string' || defaultService.trim() === '') {
    throw new Error('default_service must be a non-empty string');
  }

  if (!Array.isArray(services) || services.length === 0) {
    throw new Error('services must be a non-empty array');
  }

  const seenNames = new Set();
  for (const service of services) {
    validateDeployServiceConfig(service, seenNames);
  }

  if (!seenNames.has(defaultService)) {
    throw new Error(`default_service ${defaultService} is not in services`);
  }
}

module.exports = {
  DEPLOY_ENVIRONMENTS,
  DEPLOY_SERVICE_NAME_PATTERN,
  DEPLOY_ADAPTERS,
  DEPLOY_VALIDATION_PROFILES,
  isDeployEnvironment,
  validateDeployServiceConfig,
  validateDeployConfig
};
