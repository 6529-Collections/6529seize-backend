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

const collectorLanes = ['Normal', 'Critical'] as const;
const getArn = (id: string) => ({ 'Fn::GetAtt': [id, 'Arn'] });
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

function unchanged(original: Template, desired: Template, id: string) {
  return (
    desired.Resources[id] !== undefined &&
    same(original.Resources[id], desired.Resources[id])
  );
}

function unchangedCollectorRoute(
  original: Template,
  desired: Template,
  lane: string
) {
  const rule = desired.Resources[`${lane}Rule`];
  const targets = rule?.Properties?.Targets as { Arn?: unknown }[] | undefined;
  const permission = desired.Resources[`${lane}Invocation`];
  const props = permission?.Properties;
  return (
    unchanged(original, desired, `${lane}Rule`) &&
    rule.Type === 'AWS::Events::Rule' &&
    Array.isArray(targets) &&
    targets.length === 1 &&
    same(targets[0]?.Arn, getArn(`${lane}Collector`)) &&
    unchanged(original, desired, `${lane}Invocation`) &&
    permission.Type === 'AWS::Lambda::Permission' &&
    props?.Action === 'lambda:InvokeFunction' &&
    props.Principal === 'events.amazonaws.com' &&
    same(props.FunctionName, { Ref: `${lane}Collector` }) &&
    same(props.SourceArn, getArn(`${lane}Rule`))
  );
}

function unchangedCollectorQueuePolicy(original: Template, desired: Template) {
  const resource = desired.Resources.EventDeadLettersPolicy;
  const props = resource?.Properties;
  const document = props?.PolicyDocument as
    | {
        Version?: string;
        Statement?: {
          Effect?: string;
          Principal?: { Service?: string };
          Action?: string;
          Resource?: unknown;
          Condition?: { ArnEquals?: Record<string, unknown> };
        }[];
      }
    | undefined;
  const statement = document?.Statement?.[0];
  return (
    unchanged(original, desired, 'EventDeadLettersPolicy') &&
    resource.Type === 'AWS::SQS::QueuePolicy' &&
    same(props?.Queues, [{ Ref: 'EventDeadLetters' }]) &&
    document?.Version === '2012-10-17' &&
    document.Statement?.length === 1 &&
    statement?.Effect === 'Allow' &&
    statement.Principal?.Service === 'events.amazonaws.com' &&
    statement.Action === 'sqs:SendMessage' &&
    same(statement.Resource, getArn('EventDeadLetters')) &&
    same(
      statement.Condition?.ArnEquals?.['aws:SourceArn'],
      collectorLanes.map((lane) => getArn(`${lane}Rule`))
    )
  );
}

function collectorReevaluations(
  original: Template,
  desired: Template,
  modified: string[]
): string[] {
  const lanes = collectorLanes.filter(
    (lane) =>
      modified.includes(`${lane}Collector`) &&
      unchangedCollectorRoute(original, desired, lane)
  );
  const ids = lanes.flatMap((lane) => [`${lane}Rule`, `${lane}Invocation`]);
  if (
    lanes.length === collectorLanes.length &&
    unchangedCollectorQueuePolicy(original, desired)
  )
    ids.push('EventDeadLettersPolicy');
  return ids;
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
  reevaluated.push(...collectorReevaluations(original, template, modified));
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

function describeRejectedChange(change: ResourceChange) {
  // Structural diagnostics only: never include templates, property values or
  // CloudFormation's BeforeContext/AfterContext in workflow logs or receipts.
  return {
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
  };
}

export function retirementChangeDiagnostics(
  changes: { ResourceChange?: ResourceChange }[]
) {
  return changes.map(({ ResourceChange: change }) =>
    change ? describeRejectedChange(change) : { unreadable: true }
  );
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

function isEnvironmentUpdate(
  change: ResourceChange | undefined,
  id: string
): boolean {
  const detail = change?.Details?.[0];
  return (
    change?.Action === 'Modify' &&
    change.LogicalResourceId === id &&
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

function isDynamicEvaluation(
  change: ResourceChange | undefined,
  type: string,
  property: string,
  causes: string[],
  recreation: string
): boolean {
  return (
    change?.Action === 'Modify' &&
    change.ResourceType === type &&
    change.Scope?.length === 1 &&
    change.Scope[0] === 'Properties' &&
    change.Details?.length === causes.length &&
    new Set(change.Details.map((detail) => detail.CausingEntity)).size ===
      causes.length &&
    change.Details.every(
      (detail) =>
        detail.Evaluation === 'Dynamic' &&
        detail.ChangeSource === 'ResourceAttribute' &&
        causes.includes(detail.CausingEntity ?? '') &&
        detail.Target?.Attribute === 'Properties' &&
        detail.Target.Name === property &&
        detail.Target.RequiresRecreation === recreation
    )
  );
}

function verifiedCollectorRules(
  edit: TemplateEdit,
  changes: { ResourceChange?: ResourceChange }[]
): string[] {
  const find = (id: string) =>
    changes.find(
      ({ ResourceChange: change }) => change?.LogicalResourceId === id
    )?.ResourceChange;
  return collectorLanes.filter((lane) => {
    const rule = find(`${lane}Rule`);
    return (
      (edit.reevaluated ?? []).includes(`${lane}Rule`) &&
      isEnvironmentUpdate(find(`${lane}Collector`), `${lane}Collector`) &&
      rule?.Replacement === 'False' &&
      isDynamicEvaluation(
        rule,
        'AWS::Events::Rule',
        'Targets',
        [`${lane}Collector.Arn`],
        'Never'
      )
    );
  });
}

function isCollectorReevaluation(
  edit: TemplateEdit,
  change: ResourceChange,
  verifiedLanes: string[]
): boolean {
  if (
    !(edit.reevaluated ?? []).includes(change.LogicalResourceId ?? '') ||
    edit.modified.includes(change.LogicalResourceId ?? '')
  )
    return false;
  if (verifiedLanes.some((lane) => change.LogicalResourceId === `${lane}Rule`))
    return true;
  for (const lane of verifiedLanes) {
    if (change.LogicalResourceId !== `${lane}Invocation`) continue;
    // The complete permission and rule templates are unchanged. Its only
    // evaluation is SourceArn from an explicitly nonreplacing rule whose only
    // evaluation is Targets from an explicitly nonreplacing collector. Neither
    // rule Name/EventBusName nor permission properties can change. Conditional
    // here is the transitive GetAtt reevaluation, not permission replacement.
    return (
      (change.Replacement === 'Conditional' ||
        change.Replacement === 'False') &&
      isDynamicEvaluation(
        change,
        'AWS::Lambda::Permission',
        'SourceArn',
        [`${lane}Rule.Arn`],
        'Always'
      )
    );
  }
  return (
    change.LogicalResourceId === 'EventDeadLettersPolicy' &&
    verifiedLanes.length === collectorLanes.length &&
    change.Replacement === 'False' &&
    isDynamicEvaluation(
      change,
      'AWS::SQS::QueuePolicy',
      'PolicyDocument',
      collectorLanes.map((lane) => `${lane}Rule.Arn`),
      'Never'
    )
  );
}

export function assertRetirementChangeSet(
  edit: TemplateEdit,
  changes: { ResourceChange?: ResourceChange }[]
): void {
  const removed = new Set<string>();
  const seen = new Set<string>();
  const relayEnvironmentUpdate = isEnvironmentUpdate(
    changes.find(
      ({ ResourceChange: change }) => change?.LogicalResourceId === 'LogRelay'
    )?.ResourceChange,
    'LogRelay'
  );
  const verifiedLanes = verifiedCollectorRules(edit, changes);
  for (const { ResourceChange: change } of changes) {
    const id = change?.LogicalResourceId;
    if (!id) throw new Error('Unreadable CloudFormation resource change');
    if (seen.has(id))
      throw new Error('Duplicate CloudFormation resource change');
    seen.add(id);
    if (change.Action === 'Remove' && edit.deleted.includes(id))
      removed.add(id);
    else if (
      change.Action !== 'Modify' ||
      !(
        (change.Replacement === 'False' &&
          (edit.modified.includes(id) ||
            (relayEnvironmentUpdate &&
              isUnchangedSubscriptionEvaluation(edit, change)))) ||
        isCollectorReevaluation(edit, change, verifiedLanes)
      )
    )
      throw new Error(
        `CloudFormation proposes an unrelated change, new resource or replacement: ${JSON.stringify(describeRejectedChange(change))}`
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
