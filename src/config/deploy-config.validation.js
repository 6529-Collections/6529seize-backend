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

  if (service.name !== 'mediaResizerLoop' && 'memory_size' in service) {
    throw new Error('memory_size is supported only for mediaResizerLoop');
  }

  if (
    service.name === 'mediaResizerLoop' &&
    (!Number.isInteger(service.memory_size) ||
      service.memory_size < 512 ||
      service.memory_size > 10240 ||
      service.memory_size % 512 !== 0)
  ) {
    throw new Error(
      'mediaResizerLoop memory_size must be a multiple of 512 MiB between 512 and 10240'
    );
  }

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
  if (!Array.isArray(service.default_dependencies)) {
    throw new Error(`service ${service.name} must define default_dependencies`);
  }
  validateDeployTrainSettings(service);
  validateDeployBlackouts(service);
}

const DEPLOY_TRAIN_MODES = ['auto', 'manual'];
const DEPLOY_BLACKOUT_TYPES = ['window', 'team-freeze'];
const DEPLOY_BLACKOUT_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isNonEmptyText(value, maxLength) {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= maxLength
  );
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${label} has unsupported field ${key}`);
    }
  }
}

/** Optional `deploy_train` settings; only the deploy train reads them. */
function validateDeployTrainSettings(service) {
  if (!('deploy_train' in service)) return;
  const settings = service.deploy_train;
  const label = `service ${service.name} deploy_train`;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${label} must be an object`);
  }
  rejectUnknownKeys(settings, ['mode', 'reason'], label);
  if (!DEPLOY_TRAIN_MODES.includes(settings.mode)) {
    throw new Error(`${label}.mode must be auto or manual`);
  }
  if (settings.mode === 'manual' && !isNonEmptyText(settings.reason, 300)) {
    throw new Error(`${label}.reason is required for manual services`);
  }
  if ('reason' in settings && !isNonEmptyText(settings.reason, 300)) {
    throw new Error(`${label}.reason must be non-empty text`);
  }
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function validateWindowBlackout(rule, label) {
  rejectUnknownKeys(
    rule,
    ['type', 'reason', 'start', 'end', 'timezone', 'days'],
    label
  );
  const end = rule.end === '24:00' ? rule.end : null;
  if (
    !CLOCK_PATTERN.test(rule.start) ||
    !(end || CLOCK_PATTERN.test(rule.end))
  ) {
    throw new Error(`${label} start and end must be HH:MM`);
  }
  if (rule.start === rule.end) {
    throw new Error(`${label} start and end must differ`);
  }
  if (
    'timezone' in rule &&
    (typeof rule.timezone !== 'string' || !isValidTimeZone(rule.timezone))
  ) {
    throw new Error(`${label} timezone must be an IANA time zone`);
  }
  if ('days' in rule) {
    if (
      !Array.isArray(rule.days) ||
      rule.days.length === 0 ||
      new Set(rule.days).size !== rule.days.length ||
      rule.days.some((day) => !DEPLOY_BLACKOUT_DAYS.includes(day))
    ) {
      throw new Error(`${label} days must be unique values of sun..sat`);
    }
  }
}

/** Optional per-service quiet windows the deploy train must respect. */
function validateDeployBlackouts(service) {
  if (!('deploy_blackouts' in service)) return;
  const rules = service.deploy_blackouts;
  if (!Array.isArray(rules)) {
    throw new Error(`service ${service.name} deploy_blackouts must be a list`);
  }
  rules.forEach((rule, index) => {
    const label = `service ${service.name} deploy_blackouts[${index}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`${label} must be an object`);
    }
    if (!DEPLOY_BLACKOUT_TYPES.includes(rule.type)) {
      throw new Error(`${label}.type must be window or team-freeze`);
    }
    if (!isNonEmptyText(rule.reason, 200)) {
      throw new Error(`${label}.reason must be non-empty text`);
    }
    if (rule.type === 'window') {
      validateWindowBlackout(rule, label);
    } else {
      rejectUnknownKeys(rule, ['type', 'reason'], label);
    }
  });
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
  DEPLOY_TRAIN_MODES,
  DEPLOY_BLACKOUT_TYPES,
  DEPLOY_BLACKOUT_DAYS,
  isDeployEnvironment,
  validateDeployServiceConfig,
  validateDeployConfig
};
