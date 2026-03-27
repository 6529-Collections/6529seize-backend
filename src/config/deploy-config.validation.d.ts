export type DeployEnvironment = 'staging' | 'prod';

export type DeployServiceConfig = {
  name: string;
  allowed_environments: DeployEnvironment[];
};

export type DeployConfig = {
  default_environment: DeployEnvironment;
  default_service: string;
  services: DeployServiceConfig[];
};

export declare const DEPLOY_ENVIRONMENTS: DeployEnvironment[];
export declare const DEPLOY_SERVICE_NAME_PATTERN: RegExp;

export declare function isDeployEnvironment(
  value: string
): value is DeployEnvironment;

export declare function validateDeployServiceConfig(
  service: unknown,
  seenNames: Set<string>
): void;

export declare function validateDeployConfig(
  config: unknown
): asserts config is DeployConfig;
