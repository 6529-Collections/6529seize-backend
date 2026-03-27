import {
  GENERATED_DEPLOY_DEFAULT_ENVIRONMENT,
  GENERATED_DEPLOY_SERVICE_CONFIGS
} from '@/api/deploy/deploy.generated';

export type DeployEnvironment = 'staging' | 'prod';

export type DeployService =
  (typeof GENERATED_DEPLOY_SERVICE_CONFIGS)[number]['name'];

export type DeployServiceConfig = {
  name: DeployService;
  allowed_environments: DeployEnvironment[];
};

export const DEPLOY_REPO_OWNER = '6529-Collections';
export const DEPLOY_REPO_NAME = '6529seize-backend';
export const DEPLOY_WORKFLOW_FILE = 'deploy.yml';
export const DEPLOY_WORKFLOW_NAME = 'Deploy a service';
export const DEFAULT_DEPLOY_ENVIRONMENT: DeployEnvironment =
  GENERATED_DEPLOY_DEFAULT_ENVIRONMENT;
export const DEFAULT_DEPLOY_REF = 'main';

export const DEPLOY_SERVICES = GENERATED_DEPLOY_SERVICE_CONFIGS.map(
  (service) => service.name
) as DeployService[];

const DEPLOY_SERVICE_SET = new Set<string>(DEPLOY_SERVICES);
const DEPLOY_SERVICE_ENVIRONMENTS = new Map(
  GENERATED_DEPLOY_SERVICE_CONFIGS.map((service) => [
    service.name,
    [...service.allowed_environments]
  ])
);

export function isDeployEnvironment(value: string): value is DeployEnvironment {
  return value === 'staging' || value === 'prod';
}

export function isDeployService(value: string): value is DeployService {
  return DEPLOY_SERVICE_SET.has(value);
}

export function getAllowedEnvironmentsForService(
  service: string
): DeployEnvironment[] {
  return (
    DEPLOY_SERVICE_ENVIRONMENTS.get(service as DeployService) ?? [
      'staging',
      'prod'
    ]
  );
}

export function canDeployServiceToEnvironment(
  service: string,
  environment: DeployEnvironment
): boolean {
  return getAllowedEnvironmentsForService(service).includes(environment);
}

export function getDeployServiceConfigs(): DeployServiceConfig[] {
  return GENERATED_DEPLOY_SERVICE_CONFIGS.map((service) => ({
    name: service.name,
    allowed_environments: [...service.allowed_environments]
  }));
}
