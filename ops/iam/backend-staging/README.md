# Backend staging deployment permissions

These customer-managed policies are intended only for
`arn:aws:iam::987989283142:role/gha-backend-deploy-staging`.
The role trusts GitHub OIDC for the backend repository's `staging` environment.
That environment permits only the `1a-staging` branch. The generated deployment
workflow selects that environment and obtains staging credentials through OIDC.
Set its environment variable `AWS_DEPLOY_ROLE_ARN` to the role ARN above. The
workflow rejects missing or malformed role configuration before building or
authenticating, checks the assumed account against the ARN, and names the
temporary session `backend-staging-<GitHub run ID>` for audit correlation.
The account check is performed by the credential action when assuming the role;
the earlier validation checks ARN syntax. Configure the role from account
`987989283142` documented here.
Staging has no legacy-key fallback. Production uses a separate OIDC role in the
`production` GitHub environment, with policies and rollout evidence documented
in [the production runbook](../backend-production/README.md).

`manifest.json` records the source commit and SHA-256 of each compact JSON
policy. Ten policy documents keep exact resource lists within IAM's 6,144
character managed-policy limit and the role's default ten-attachment limit.
The split is a size boundary; all ten documents form one permission set.

## Scope

The inventory was taken on 2026-10-13 from the staging service catalog,
Serverless definitions, deployment workflow, installed Serverless deployment
implementation, and the physical resources of all 53 matching CloudFormation
stacks in `eu-west-1`.

Before rollout, the inventory was extended using `1a-staging` to include the
existing `websocketOutboundHandler-staging` stack, which was not yet on main.
The final scope covers 55 staging services, 54 stacks and deployment buckets,
62 functions including `seizeAPI`, and the additional handler's exact queues,
rule, mapping, alarms, and log group. `manifest.json` records both source refs.

- Function operations cover the 61 stack-owned functions and `seizeAPI` in
  `eu-west-1`, including their published versions. Only `dbMigrationsLoop` can
  be invoked directly by the deployment role.
- CloudFormation operations are limited to the 54 catalog-owned staging stacks.
  The current stacks have no CloudFormation execution role; resource operations
  therefore remain subject to this deployment role's permissions. No
  CloudFormation service role may be passed.
- Artifact access is limited to the 54 existing Serverless deployment buckets.
  The shared private ingest bucket has only the read-only bucket preflight
  permissions needed by the API deployment. Its objects and bucket policy
  cannot be accessed or changed through this role.
- Queue, rule, schedule, alarm, and log-group permissions use explicit resource
  names from the approved stacks. Lambda event-source mapping creation and
  modification additionally require an approved target function ARN.
- `iam:PassRole` is limited to `lambda-vpc-role`, and only to the Lambda and
  EventBridge Scheduler services. `iam:GetRole` reads that same role. No IAM
  identities, credentials, trust policies, or permission policies may be
  administered.
- The VPC checks needed by Lambda deployment allow only network description
  APIs in `eu-west-1`, with `GetSecurityGroupsForVpc` limited to the configured
  staging VPC.
- TDH calculation subscriptions are limited to the staging calculation topic;
  new subscriptions must use the three approved SQS endpoints. SNS subscription
  modification/deletion is topic-scoped because those operations authorize
  against the topic rather than a subscription ARN.

## Deliberate limits

IAM changes in `dropVideoConversionInvokerLoop`,
`artworkDocumentationProcessor`, and `artworkDocumentationStorage` require a
separate administrative infrastructure step. In particular, granting arbitrary
`iam:PutRolePolicy` on the shared execution role would permit privilege
escalation. The deployment role does not receive this permission. The storage
stacks' application-bucket, backup, malware-protection, and IAM provisioning
also remain administrative operations. Ordinary deployments can update
existing application functions without changing those resources; infrastructure
changes must be provisioned and verified first.

Wildcard-resource statements are limited to APIs that do not support useful
resource scoping: CloudFormation template validation, network and log metadata,
and function-constrained event-source mapping creation. CloudWatch requires
wildcard-resource authorization to read and write composite alarms; those
operations are restricted to `eu-west-1`. This gives the role regional
composite-alarm access beyond the one current backend composite alarm.

Exact artifact-bucket names and mapping tag ARNs deliberately fail closed after
resource replacement. Before replacing resources, review the new names and
update these policies using separate administrative credentials. Do not grant
account-wide service permissions to resolve a deployment failure.

The existing `lambda-vpc-role` is shared with production and has broad runtime
permissions. A principal allowed to deploy code can exercise that code's
runtime permissions indirectly. This policy limits direct deployment access;
separating and reducing application execution roles remains a separate change.

## Validation and rollout

The policies were attached and verified on 2026-10-13. IAM Access Analyzer
reported no findings across all ten documents. IAM custom-policy simulation
passed 27 positive cases and all 22 negative cases covering production,
unrelated resources, credential administration, runtime-policy administration,
Secrets Manager, SSM, EC2 destruction, RDS destruction, and KMS.

One additional SNS case returned an inconsistent simulator result: even an
unconditional wildcard policy was denied when a subscription resource ARN was
supplied. A temporary role with only the topic-scoped subscription read
permission successfully read the actual staging subscription. The narrow topic
scope was retained; it was not widened to make simulation pass. Subscription
modification and deletion have not been exercised against live subscriptions.

A second temporary role used the final ten policies with a read-only STS
session policy. Eleven live checks passed: Lambda configuration metadata,
CloudFormation stack metadata, deployment-bucket and ingest-bucket preflight,
queue URL, rule metadata, schedule metadata, log-filter metadata, alarm
metadata, subnet metadata, and subscription metadata. Both temporary roles were
deleted after verification; temporary session credentials were never saved.
Those read checks covered the initial inventory. The additional WebSocket
resources were verified through live stack inventory and the repeated policy
simulation, including its event-source mapping function condition.
Remote managed-policy versions match the local documents. The staging OIDC
role has exactly these ten attached policies, no inline policy, and its original
restricted trust policy. The backend lint command also passed.

For future updates, repeat policy validation and the positive/negative checks,
then verify remote versions and the complete role attachment set. See
`verification.json` for this installation's evidence summary.

Simulation establishes identity-policy matching, not a successful deployment or
the behavior of all resource policies and service controls. Run a real staging
OIDC deployment after the workflow change, then verify its version, health, and
related E2E results. Keep the existing credentials until the migration is
verified. Use an `api` staging deployment as the initial OIDC smoke test; this
workflow-only change needs no schema migration or frontend release. Other
Serverless deployment paths still need live validation within the deliberate
limits documented above.

For subsequent policy updates, review the changed service/resource inventory,
revalidate and simulate the resulting documents, then publish new managed
policy versions through the administrative identity. Never give the deployment
role permission to modify these policies or its trust configuration.

Follow-up: separate staging and production Lambda execution roles and reduce
their runtime permissions before treating this migration as runtime isolation.
The first live rollout is limited to the API smoke test; validate each remaining
deployment adapter before relying on it for ordinary infrastructure changes.

References:

- [Lambda VPC deployment permissions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html)
- [CloudFormation service roles](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html)
- [IAM policy simulation limitations](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_testing-policies.html)
- [IAM policy quotas](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html)

## WebSocket recovery worker

`WebSocketDeliveryDeployment.json` is an additional narrowly scoped inline policy for the existing deployment role. An administrative identity installs it before deploying `webSocketDeliveryLoop`; the GitHub role cannot modify its own permissions. It permits only the new worker function/versions, its environment-specific CloudFormation stack, deployment-bucket prefix, schedule, log group and alarms. Existing managed policies and their ten attachments are unchanged. The deployment-bucket prefix allows CloudFormation's truncated stack component and generated suffix (for example, `websocketdeliveryloop-sta-serverlessdeploymentbuck-...` on staging); it does not grant application-data access. Validate the document with Access Analyzer and simulate new-worker operations and unrelated denials before installation. Deploy through the ordinary GitHub workflow afterward.
