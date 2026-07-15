export type DeployEnvironment = 'staging' | 'prod';

export type DeployServiceConfig = {
  name: string;
  allowed_environments: DeployEnvironment[];
  deploy_adapter:
    | 'serverless'
    | 'resources-only'
    | 'api-zip'
    | 'direct-lambda-zip'
    | 'special-script';
  aws_region: Partial<Record<DeployEnvironment, string>>;
  verification_targets: string[];
  validation_profile:
    | 'lambda-version'
    | 'api-health'
    | 'cloudformation-stack'
    | 'lambda-edge-association';
  staging_policy: 'allowed' | 'production-only';
  default_dependencies: string[];
  automatic_rollback_supported: boolean;
};

export type DeployConfig = {
  default_environment: DeployEnvironment;
  default_service: string;
  services: DeployServiceConfig[];
};

export declare const DEPLOY_ENVIRONMENTS: DeployEnvironment[];
export declare const DEPLOY_SERVICE_NAME_PATTERN: RegExp;
export declare const DEPLOY_ADAPTERS: DeployServiceConfig['deploy_adapter'][];
export declare const DEPLOY_VALIDATION_PROFILES: DeployServiceConfig['validation_profile'][];

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
