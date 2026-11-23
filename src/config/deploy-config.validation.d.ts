export type DeployEnvironment = 'staging' | 'prod';

export type DeployServiceConfig = {
  name: string;
  /** Supported only for mediaResizerLoop; rejected on all other services. */
  memory_size?: number;
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
  default_dependencies: string[];
  /** Deploy-train settings; `manual` keeps the service report-only. */
  deploy_train?: DeployTrainSettings;
  /** Quiet windows in which the deploy train must not deploy the service. */
  deploy_blackouts?: DeployBlackoutRule[];
};

export type DeployTrainSettings = {
  mode: 'auto' | 'manual';
  reason?: string;
};

export type DeployBlackoutDay =
  | 'sun'
  | 'mon'
  | 'tue'
  | 'wed'
  | 'thu'
  | 'fri'
  | 'sat';

export type DeployBlackoutRule =
  | {
      type: 'window';
      reason: string;
      /** HH:MM in `timezone` (UTC by default); `end` may be 24:00. */
      start: string;
      end: string;
      timezone?: string;
      /** Days on which the window starts; all days when omitted. */
      days?: DeployBlackoutDay[];
    }
  | {
      /** Blocked whenever any announced team window is active. */
      type: 'team-freeze';
      reason: string;
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
export declare const DEPLOY_TRAIN_MODES: DeployTrainSettings['mode'][];
export declare const DEPLOY_BLACKOUT_TYPES: DeployBlackoutRule['type'][];
export declare const DEPLOY_BLACKOUT_DAYS: DeployBlackoutDay[];

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
