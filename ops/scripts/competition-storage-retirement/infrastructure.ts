/** Narrow CloudFormation edits against the freshly fetched live template. This
 * avoids deploying unrelated monitoring changes while retiring one producer. */
export const RETIRED_MIGRATOR = 'competitionMigrationLoop';

type Resource = {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | string[];
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  [key: string]: unknown;
};
export interface Template {
  Resources: Record<string, Resource>;
  [key: string]: unknown;
}
export interface TemplateEdit {
  template: Template;
  deleted: string[];
  modified: string[];
  reevaluated?: string[];
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function removeProducerAllowlist(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeProducerAllowlist);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (
        (key === 'ALLOWED_SERVICES' || key === 'ALLOWED_LOG_GROUPS') &&
        typeof entry === 'string'
      )
        return [
          key,
          entry
            .split(',')
            .filter(
              (name) =>
                name !== RETIRED_MIGRATOR &&
                name !== `/aws/lambda/${RETIRED_MIGRATOR}`
            )
            .join(',')
        ];
      return [key, removeProducerAllowlist(entry)];
    })
  );
}

function dependencies(resource: Resource): string[] {
  return typeof resource.DependsOn === 'string'
    ? [resource.DependsOn]
    : (resource.DependsOn ?? []);
}

export function removeMigratorMonitoring(original: Template): TemplateEdit {
  const template = clone(original);
  const targets = [
    `${RETIRED_MIGRATOR}ErrorLogs`,
    `${RETIRED_MIGRATOR}Errors`,
    `${RETIRED_MIGRATOR}Throttles`
  ];
  const present = targets.filter((id) => template.Resources[id]);
  if (present.length !== 0 && present.length !== targets.length)
    throw new Error('Inspect partially registered migrator monitoring');
  for (const id of present) {
    const resource = template.Resources[id];
    if (id.endsWith('ErrorLogs')) {
      if (
        resource.Type !== 'AWS::Logs::SubscriptionFilter' ||
        resource.Properties?.LogGroupName !== `/aws/lambda/${RETIRED_MIGRATOR}`
      )
        throw new Error(
          'Unexpected ownership of retired monitoring subscription'
        );
    } else {
      const metric = id.endsWith('Throttles') ? 'Throttles' : 'Errors';
      if (
        resource.Type !== 'AWS::CloudWatch::Alarm' ||
        resource.Properties?.Namespace !== 'AWS/Lambda' ||
        resource.Properties?.MetricName !== metric ||
        JSON.stringify(resource.Properties.Dimensions) !==
          JSON.stringify([{ Name: 'FunctionName', Value: RETIRED_MIGRATOR }])
      )
        throw new Error('Unexpected ownership of retired monitoring alarm');
    }
    delete template.Resources[id];
  }
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (
      dependencies(resource).some((dependency) => present.includes(dependency))
    ) {
      const expanded = dependencies(resource).flatMap((dependency) =>
        present.includes(dependency)
          ? dependencies(original.Resources[dependency])
          : [dependency]
      );
      resource.DependsOn = Array.from(new Set(expanded));
    }
    template.Resources[id] = removeProducerAllowlist(resource) as Resource;
  }
  if (JSON.stringify(template).includes(RETIRED_MIGRATOR))
    throw new Error(
      'Unexpected remaining migrator reference; inspect instead of broad string replacement'
    );
  const modified = Object.keys(template.Resources).filter(
    (id) =>
      JSON.stringify(template.Resources[id]) !==
      JSON.stringify(original.Resources[id])
  );
  // Updating the relay environment makes CloudFormation reevaluate GetAtt ARN
  // references even though the function identity and subscription are unchanged.
  const reevaluated = modified.includes('LogRelay')
    ? Object.keys(template.Resources).filter((id) => {
        const resource = template.Resources[id];
        return (
          !modified.includes(id) &&
          resource.Type === 'AWS::Logs::SubscriptionFilter' &&
          JSON.stringify(resource.Properties?.DestinationArn) ===
            JSON.stringify({ 'Fn::GetAtt': ['LogRelay', 'Arn'] }) &&
          JSON.stringify(resource) === JSON.stringify(original.Resources[id])
        );
      })
    : [];
  return { template, deleted: present, modified, reevaluated };
}

function assertMigratorResourceOwnership(resources: Template['Resources']) {
  const functionId = 'CompetitionMigrationLoopLambdaFunction';
  const functionReference = { Ref: functionId };
  const arn = { 'Fn::GetAtt': [functionId, 'Arn'] };
  const fn = resources[functionId].Properties;
  if (
    fn?.FunctionName !== RETIRED_MIGRATOR ||
    fn.ReservedConcurrentExecutions !== 0 ||
    fn.Role !== 'arn:aws:iam::987989283142:role/lambda-vpc-role'
  )
    throw new Error(
      'Retired function identity, shared role or zero-concurrency fence changed'
    );
  const policy = resources.CompetitionMigrationContinuationPolicy.Properties;
  const document = policy?.PolicyDocument as
    | { Statement?: unknown }
    | undefined;
  const expected = [
    {
      Effect: 'Allow',
      Action: 'lambda:InvokeFunction',
      Resource: [arn, { 'Fn::Join': [':', [arn, '*']] }]
    }
  ];
  if (
    JSON.stringify(policy?.Roles) !== JSON.stringify(['lambda-vpc-role']) ||
    JSON.stringify(document?.Statement) !== JSON.stringify(expected)
  )
    throw new Error(
      'Continuation policy is not exclusively scoped to the retired function'
    );
  const events = resources.CompetitionMigrationLoopLambdaEvConf.Properties;
  if (
    JSON.stringify(events?.FunctionName) !==
      JSON.stringify(functionReference) ||
    events?.MaximumEventAgeInSeconds !== 60 ||
    events.MaximumRetryAttempts !== 0
  )
    throw new Error('Retired continuation ownership or expiry changed');
  if (
    resources.CompetitionMigrationLoopLogGroup.Properties?.LogGroupName !==
      `/aws/lambda/${RETIRED_MIGRATOR}` ||
    JSON.stringify(
      resources.ServerlessDeploymentBucketPolicy.Properties?.Bucket
    ) !== JSON.stringify({ Ref: 'ServerlessDeploymentBucket' })
  )
    throw new Error('Retired logs or recovery bucket ownership changed');
  for (const [id, resource] of Object.entries(resources)) {
    if (
      resource.Type === 'AWS::Lambda::Version' &&
      JSON.stringify(resource.Properties?.FunctionName) !==
        JSON.stringify(functionReference)
    )
      throw new Error('Retired version belongs to another function');
    if (
      id === 'CompetitionMigrationFailureAlarm' ||
      id === 'CompetitionMigrationDroppedContinuationAlarm'
    ) {
      if (
        resource.Properties?.Namespace !== 'AWS/Lambda' ||
        JSON.stringify(resource.Properties.Dimensions) !==
          JSON.stringify([{ Name: 'FunctionName', Value: RETIRED_MIGRATOR }])
      )
        throw new Error('Retired alarm belongs to another producer');
    }
  }
}

export function retainMigratorRecoveryArtifacts(
  original: Template
): TemplateEdit {
  const template = clone(original);
  const allowed = new Map([
    ['CompetitionMigrationContinuationPolicy', 'AWS::IAM::Policy'],
    ['CompetitionMigrationDroppedContinuationAlarm', 'AWS::CloudWatch::Alarm'],
    ['CompetitionMigrationFailureAlarm', 'AWS::CloudWatch::Alarm'],
    ['CompetitionMigrationLoopLambdaEvConf', 'AWS::Lambda::EventInvokeConfig'],
    ['CompetitionMigrationLoopLambdaFunction', 'AWS::Lambda::Function'],
    ['CompetitionMigrationLoopLogGroup', 'AWS::Logs::LogGroup'],
    ['ServerlessDeploymentBucket', 'AWS::S3::Bucket'],
    ['ServerlessDeploymentBucketPolicy', 'AWS::S3::BucketPolicy']
  ]);
  let versions = 0;
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (
      id.startsWith('CompetitionMigrationLoopLambdaVersion') &&
      resource.Type === 'AWS::Lambda::Version'
    )
      versions++;
    else if (allowed.get(id) !== resource.Type)
      throw new Error('Unexpected resource in retired migrator stack');
  }
  if (versions !== 1 || Object.keys(template.Resources).length !== 9)
    throw new Error('Retired migrator stack resource inventory changed');
  assertMigratorResourceOwnership(template.Resources);
  const modified = [
    'ServerlessDeploymentBucket',
    'ServerlessDeploymentBucketPolicy'
  ];
  for (const id of modified) {
    template.Resources[id].DeletionPolicy = 'Retain';
    template.Resources[id].UpdateReplacePolicy = 'Retain';
  }
  const logs = template.Resources.CompetitionMigrationLoopLogGroup;
  if (logs.DeletionPolicy && logs.DeletionPolicy !== 'Delete') {
    logs.DeletionPolicy = 'Delete';
    modified.push('CompetitionMigrationLoopLogGroup');
  }
  return {
    template,
    deleted: [],
    modified: modified.filter(
      (id) =>
        JSON.stringify(template.Resources[id]) !==
        JSON.stringify(original.Resources[id])
    )
  };
}

interface ResourceChange {
  Action?: string;
  LogicalResourceId?: string;
  ResourceType?: string;
  Replacement?: string | null;
  Scope?: string[];
  Details?: {
    Target?: {
      Attribute?: string;
      Name?: string;
      RequiresRecreation?: string;
    };
    Evaluation?: string;
    ChangeSource?: string;
    CausingEntity?: string;
  }[];
}

function describeRejectedChange(change: ResourceChange): string {
  // Structural diagnostics only: never include templates, property values or
  // CloudFormation's BeforeContext/AfterContext in workflow logs or receipts.
  return JSON.stringify({
    id: change.LogicalResourceId,
    action: change.Action,
    resourceType: change.ResourceType,
    replacement: change.Replacement,
    scope: change.Scope,
    details: change.Details?.map((detail) => ({
      evaluation: detail.Evaluation,
      source: detail.ChangeSource,
      causingEntity: detail.CausingEntity,
      target: detail.Target && {
        attribute: detail.Target.Attribute,
        name: detail.Target.Name,
        requiresRecreation: detail.Target.RequiresRecreation
      }
    }))
  });
}

function isUnchangedSubscriptionEvaluation(
  edit: TemplateEdit,
  change: ResourceChange
): boolean {
  const detail = change.Details?.[0];
  return (
    !!change.LogicalResourceId &&
    (edit.reevaluated ?? []).includes(change.LogicalResourceId) &&
    change.ResourceType === 'AWS::Logs::SubscriptionFilter' &&
    change.Scope?.length === 1 &&
    change.Scope[0] === 'Properties' &&
    change.Details?.length === 1 &&
    detail?.Evaluation === 'Dynamic' &&
    detail.ChangeSource === 'ResourceAttribute' &&
    detail.CausingEntity === 'LogRelay.Arn' &&
    detail.Target?.Attribute === 'Properties' &&
    detail.Target.Name === 'DestinationArn' &&
    detail.Target.RequiresRecreation === 'Never'
  );
}

function isRelayEnvironmentUpdate(change: ResourceChange | undefined): boolean {
  const detail = change?.Details?.[0];
  return (
    change?.Action === 'Modify' &&
    change.LogicalResourceId === 'LogRelay' &&
    change.ResourceType === 'AWS::Lambda::Function' &&
    change.Replacement === 'False' &&
    change.Scope?.length === 1 &&
    change.Scope[0] === 'Properties' &&
    change.Details?.length === 1 &&
    detail?.Evaluation === 'Static' &&
    detail.ChangeSource === 'DirectModification' &&
    detail.Target?.Attribute === 'Properties' &&
    detail.Target.Name === 'Environment' &&
    detail.Target.RequiresRecreation === 'Never'
  );
}

export function assertRetirementChangeSet(
  edit: TemplateEdit,
  changes: { ResourceChange?: ResourceChange }[]
): void {
  const removed = new Set<string>();
  const relayEnvironmentUpdate = isRelayEnvironmentUpdate(
    changes.find(
      ({ ResourceChange: change }) => change?.LogicalResourceId === 'LogRelay'
    )?.ResourceChange
  );
  for (const { ResourceChange: change } of changes) {
    const id = change?.LogicalResourceId;
    if (!id) throw new Error('Unreadable CloudFormation resource change');
    if (change.Action === 'Remove' && edit.deleted.includes(id))
      removed.add(id);
    else if (
      change.Action !== 'Modify' ||
      (!edit.modified.includes(id) &&
        !(
          relayEnvironmentUpdate &&
          isUnchangedSubscriptionEvaluation(edit, change)
        )) ||
      change.Replacement !== 'False'
    )
      throw new Error(
        `CloudFormation proposes an unrelated change, new resource or replacement: ${describeRejectedChange(change)}`
      );
  }
  if (removed.size !== edit.deleted.length)
    throw new Error(
      'CloudFormation does not remove the complete reviewed producer registration'
    );
}

/** Preserve the audited identity boundary: these source stacks have no service
 * role; monitoring uses only its existing environment-scoped execution role. */
export function retirementExecutionRole(
  environment: 'staging' | 'prod',
  kind: string,
  stackRole?: string,
  requestedRole?: string
): string | undefined {
  if (kind !== 'monitoring') {
    if (stackRole || requestedRole)
      throw new Error(
        'Audited source and migrator stacks must retain direct-caller execution without a role override'
      );
    return undefined;
  }
  const expected = `arn:aws:iam::876382073372:role/6529-observability-${environment}-cfn-execution`;
  if (
    (stackRole && stackRole !== expected) ||
    (requestedRole ?? stackRole) !== expected
  )
    throw new Error(
      'Unexpected scoped monitoring CloudFormation execution role'
    );
  return expected;
}
