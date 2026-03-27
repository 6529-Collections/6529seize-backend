import deployConfigJson from '../../../../config/deploy-services.json';

export type DeployEnvironment = 'staging' | 'prod';

export type DeployServiceConfig = {
  name: string;
  allowed_environments: DeployEnvironment[];
};

export const DEPLOY_REPO_OWNER = '6529-Collections';
export const DEPLOY_REPO_NAME = '6529seize-backend';
export const DEPLOY_WORKFLOW_FILE = 'deploy.yml';
export const DEPLOY_WORKFLOW_NAME = 'Deploy a service';

const DEPLOY_CONFIG = deployConfigJson as {
  default_environment: DeployEnvironment;
  default_service: string;
  services: DeployServiceConfig[];
};

export const DEFAULT_DEPLOY_ENVIRONMENT: DeployEnvironment =
  DEPLOY_CONFIG.default_environment;
export const DEFAULT_DEPLOY_REF = 'main';

export const DEPLOY_SERVICES = DEPLOY_CONFIG.services.map(
  (service) => service.name
) as string[];

const DEPLOY_SERVICE_SET = new Set<string>(DEPLOY_SERVICES);
const DEPLOY_SERVICE_ENVIRONMENTS = new Map(
  DEPLOY_CONFIG.services.map((service) => [
    service.name,
    [...service.allowed_environments]
  ])
);

export function isDeployEnvironment(value: string): value is DeployEnvironment {
  return value === 'staging' || value === 'prod';
}

export function isDeployService(value: string): boolean {
  return DEPLOY_SERVICE_SET.has(value);
}

export function getAllowedEnvironmentsForService(
  service: string
): DeployEnvironment[] {
  return DEPLOY_SERVICE_ENVIRONMENTS.get(service) ?? [];
}

export function canDeployServiceToEnvironment(
  service: string,
  environment: DeployEnvironment
): boolean {
  return getAllowedEnvironmentsForService(service).includes(environment);
}

export function getDeployServiceConfigs(): DeployServiceConfig[] {
  return DEPLOY_SERVICES.map((service) => ({
    name: service,
    allowed_environments: [...getAllowedEnvironmentsForService(service)]
  }));
}
