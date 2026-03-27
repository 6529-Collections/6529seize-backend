const DEPLOY_ENVIRONMENTS = ['staging', 'prod'];
const DEPLOY_SERVICE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

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
  isDeployEnvironment,
  validateDeployServiceConfig,
  validateDeployConfig
};
