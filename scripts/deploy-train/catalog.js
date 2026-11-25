'use strict';

const {
  validateDeployConfig
} = require('../../src/config/deploy-config.validation.js');

const MIGRATIONS_SERVICE = 'dbMigrationsLoop';
const TRAIN_ONLY_FIELDS = ['deploy_blackouts', 'deploy_train'];

function compareText(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** Validates the catalog and indexes it by service name. */
function loadCatalog(config) {
  validateDeployConfig(config);
  const byName = new Map(
    config.services.map((service, index) => [service.name, { service, index }])
  );
  return { config, services: config.services, byName };
}

function getService(catalog, name) {
  const found = catalog.byName.get(name);
  if (!found) throw new Error(`Unknown deploy service ${name}`);
  return found.service;
}

function serviceDirectory(name) {
  return name === 'api' ? 'src/api-serverless' : `src/${name}`;
}

function servicesForEnvironment(catalog, environment) {
  return catalog.services.filter((service) =>
    service.allowed_environments.includes(environment)
  );
}

/**
 * The catalog fields that change how a service is deployed. Train-only
 * scheduling fields are excluded, so editing a blackout window does not
 * count as a deployment change for the service itself.
 */
function deploymentDefinition(service) {
  const definition = {};
  for (const key of Object.keys(service).sort(compareText)) {
    if (!TRAIN_ONLY_FIELDS.includes(key)) definition[key] = service[key];
  }
  return definition;
}

function trainSettings(service) {
  const settings = service.deploy_train || {};
  return {
    mode: settings.mode || 'auto',
    reason: settings.reason || null
  };
}

/** Every direct and indirect dependency of each service; rejects cycles. */
function transitiveDependencies(catalog) {
  const closure = new Map();
  const visiting = new Set();
  const visit = (name, path) => {
    if (closure.has(name)) return closure.get(name);
    if (visiting.has(name)) {
      throw new Error(
        `default_dependencies cycle: ${path.concat(name).join(' -> ')}`
      );
    }
    visiting.add(name);
    const result = new Set();
    for (const dependency of getService(catalog, name).default_dependencies) {
      if (!catalog.byName.has(dependency)) {
        throw new Error(`${name} depends on unknown service ${dependency}`);
      }
      result.add(dependency);
      for (const nested of visit(dependency, path.concat(name))) {
        result.add(nested);
      }
    }
    visiting.delete(name);
    closure.set(name, result);
    return result;
  };
  for (const service of catalog.services) visit(service.name, []);
  return closure;
}

function compareKeys(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Orders `names` so every service follows the services it (transitively)
 * depends on. dbMigrationsLoop always goes first. Among services that are
 * ready at the same time, `priorityOf(name)` (lower first) and then catalog
 * order break the tie; the train passes "behind since" so the oldest drift
 * ships first and no service starves when trains are interrupted.
 */
function dependencyOrder(catalog, names, priorityOf = () => []) {
  const closure = transitiveDependencies(catalog);
  const pending = new Set(names);
  for (const name of pending) getService(catalog, name);
  const sortKey = (name) => [
    name === MIGRATIONS_SERVICE ? 0 : 1,
    ...priorityOf(name),
    catalog.byName.get(name).index
  ];
  const ordered = [];
  while (pending.size > 0) {
    const ready = Array.from(pending).filter(
      (name) =>
        !Array.from(pending).some(
          (other) => other !== name && closure.get(name).has(other)
        )
    );
    ready.sort((left, right) => compareKeys(sortKey(left), sortKey(right)));
    const next = ready[0];
    ordered.push(next);
    pending.delete(next);
  }
  return ordered;
}

/** Services in `names` that depend, directly or not, on `name`. */
function dependentsOf(catalog, name, names) {
  const closure = transitiveDependencies(catalog);
  return names.filter((candidate) => closure.get(candidate).has(name));
}

module.exports = {
  MIGRATIONS_SERVICE,
  TRAIN_ONLY_FIELDS,
  compareText,
  loadCatalog,
  getService,
  serviceDirectory,
  servicesForEnvironment,
  deploymentDefinition,
  trainSettings,
  transitiveDependencies,
  dependencyOrder,
  dependentsOf
};
