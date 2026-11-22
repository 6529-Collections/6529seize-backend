# Backend production deployment permissions

These policies belong to
`arn:aws:iam::987989283142:role/gha-backend-deploy-production`.
Its trust policy accepts GitHub OIDC only for
`repo:6529-Collections/6529seize-backend:environment:production`, with audience
`sts.amazonaws.com`. The GitHub `production` environment permits only the
`main` branch. IAM roles are global; the application deployment region is
`us-east-1`.

Set the environment variable `AWS_DEPLOY_ROLE_ARN` to the role ARN above.
The generated workflow validates its syntax before checkout/build, checks the
assumed account against the ARN, and requires successful authentication before
deployment. Production sessions use `backend-prod-<GitHub run ID>` for audit
correlation. Both backend environments use separate OIDC roles with no static
key fallback. The role cannot administer its own trust or permission policies.

## Resource scope

The inventory was collected on 2026-10-13 from the production service catalog,
Serverless definitions, deployment scripts, and all 56 existing matching
CloudFormation stacks. `manifest.json` records the source commit and compact
JSON SHA-256 and character count for each policy. Ten documents fit within
IAM's managed-policy size and default role attachment limits.

- Function deployment operations cover the 64 stack-owned functions,
  `seizeAPI`, and `nextgenMediaProxyInterceptor`, including qualified versions.
  Only `dbMigrationsLoop` may be invoked directly by the deployment role.
- CloudFormation operations cover the 56 exact production stacks. These stacks
  use caller permissions; the role cannot pass a CloudFormation execution role.
- Artifact permissions cover the 56 physical Serverless deployment buckets.
  Queue, rule, schedule, mapping, log-group, and alarm operations use the actual
  production resource inventory. Event-source mapping creation/modification
  requires an approved function ARN.
- `iam:GetRole` and `iam:PassRole` cover only `lambda-vpc-role`; passing it is
  restricted to Lambda and EventBridge Scheduler. No IAM policy, identity,
  credential, trust, or service-linked-role administration is granted.
- VPC checks cover network description in `us-east-1`, with
  `GetSecurityGroupsForVpc` restricted to the configured production VPC.
- SNS subscription operations cover the production calculation topic; new
  subscriptions require the approved SQS endpoints and protocol.
- The API preflight may describe only the existing `prod/lambdas` secret. It
  cannot read secret values, describe other secrets, or alter secrets.
- The shared private ingest bucket in `eu-west-1` is owned by the production
  CDK stack `Prod-MediaShared` in 6529-infra.
  Production has only `ListBucket`/`GetBucketLocation` preflight access to this
  exact bucket in Ireland or Virginia. Object access and policy mutation are
  excluded. Other regional deployment operations remain in `us-east-1`.
- NextGen edge deployment may read/update only distribution `E1RI37JRN0ZK6J`
  and enable/disable replication only for versions of its existing interceptor
  function. The required Lambda replicator and CloudFront logger service-linked
  roles already exist; creating or repairing those roles remains administrative.

## Infrastructure boundaries

IAM changes in `artworkDocumentationProcessor`,
`artworkDocumentationStorage` and `dropVideoConversionInvokerLoop` require a separate administrative step.
Application storage, backup, malware-protection, and IAM provisioning also
remain administrative. An unchanged infrastructure definition can accompany a
normal function update; provision and verify infrastructure changes first.
Arbitrary policy writes on the shared execution role would permit privilege
escalation and are deliberately excluded.

The existing Lambda execution role has broad runtime permissions and is shared
with staging. Code deployment can exercise the function's runtime permissions
indirectly. Deployment credential migration restricts direct control-plane
access; separating and reducing execution roles remains follow-up work.

Wildcard-resource permissions cover APIs without useful resource scoping:
template validation, network/log metadata, function-constrained mapping
creation, and regional composite-alarm operations. CloudWatch composite-alarm
read/write access extends beyond the one current backend composite alarm in
`us-east-1`. CloudFront operations are global and scoped to one distribution.

Exact bucket names, mapping tag ARNs, and the production secret ARN fail closed
after resource replacement. Review and refresh policies through administrative
credentials instead of granting account-wide permissions.

## Validation and rollout

Validate every document with IAM Access Analyzer, simulate positive deployment
and negative unrelated/administrative operations, verify scoped live reads using
a read-only session, and compare remote versions and the complete attachment
set with the manifest before selecting the role in GitHub.

The SNS subscription simulator has the same documented inconsistency as the
staging policy: resource-specific simulation can deny even a wildcard identity
policy. Validate the narrow production topic scope with a live subscription
read; do not widen it to satisfy simulation. Subscription writes remain
untested until an actual resource change requires them.

First test the complete workflow on staging, including its generated-file and
authentication-boundary tests. After staging health and related E2E checks pass,
merge the reviewed PR into main and deploy `api` to production, followed by
`nftsLoop` as the representative Serverless deployment. No application source
or schema change is included; existing prerequisites need no redeployment.
Verify role identity, artifact digests, runtime version/health, stack status,
and related production E2E results. Keep existing keys until migration is
verified and the local CLI has separate human administrative credentials.

See `verification.json` for the installation snapshot and the PR rollout
evidence for subsequent deployment results. Other resource-specific adapters
and administrative infrastructure changes retain the boundaries above.

References:

- [GitHub OIDC in AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
- [Lambda@Edge permissions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-edge-permissions.html)
- [CloudFormation service roles](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html)
- [IAM policy quotas](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html)

## WebSocket recovery worker

`WebSocketDeliveryDeployment.json` is an additional narrowly scoped inline policy for the existing deployment role. An administrative identity installs it before deploying `webSocketDeliveryLoop`; the GitHub role cannot modify its own permissions. It permits only the new worker function/versions, its environment-specific CloudFormation stack, deployment-bucket prefix, schedule, log group and alarms. Existing managed policies and their ten attachments are unchanged. The deployment-bucket prefix allows CloudFormation's truncated stack component and generated suffix (for example, `websocketdeliveryloop-sta-serverlessdeploymentbuck-...` on staging); it does not grant application-data access. Validate the document with Access Analyzer and simulate new-worker operations and unrelated denials before installation. Deploy through the ordinary GitHub workflow afterward.

## Drop Forge handlers (proposed, not applied)

`DropForgeHandlersDeployment.json` and `DropForgeDispatchDeployment.json` supplement the existing deploy role for
`dropForgeLaunchHandler` and `memesDistributionHandler`: their stacks, artifact
buckets, functions, logs/alarms, queues, schedule group, four readiness schedules
and dedicated execution- and delivery-role PassRole. It grants no KMS signing or IAM-policy-editing permission. An AWS
administrator must review/apply this addition before rollout; the existing
`manifest.json` and `verification.json` describe the earlier applied policies and
do not claim this addition was deployed or AWS-validated. Check managed-policy
attachment quota and regroup scoped policy statements administratively if needed.
Runtime role policies and queue-producer permissions are separate; see the
[maintained setup guide](../../../docs/drop-forge-auto-launch-setup.md).

GetEventSourceMapping is read-only and region-scoped across mapping IDs because
new UUIDs do not exist before creation and that read API has no FunctionArn
condition. Mapping creation/update/delete remains constrained to the two named
functions. The longer distribution stack's generated artifact bucket prefix is
service-scoped; its AWS region condition separates staging from production.

## Voting credit return worker

`VotingCreditReturnDeployment.json` enrolls only the voting credit return
notification worker in this environment. Install it as the
`VotingCreditReturnDeployment` inline policy on this environment's existing
GitHub deployment role through the administrative identity after Access Analyzer
validation and positive/negative simulation. The ten managed policies, trust
policy and runtime role remain unchanged. The exact schedule name is declared
in the worker definition; four alarm ARNs are enumerated. CloudFormation truncates
the long stack name in generated deployment buckets, so artifact access uses
the unique `votingcreditreturnnotific*-serverlessdeploy*` prefix with the
environment's required AWS region. It grants no application-bucket access.
Keep the aggregate role inline-policy size below 10,240 characters. Verify the
remote document and unrelated-resource/other-environment denials, then deploy
through GitHub Actions and verify the disabled schedule before activation.

## Drop video conversion worker

`dropVideoConversionInvokerLoop` deploys to production in `eu-west-1`, next to
the production media bucket whose `drops/` uploads it converts. It has no VPC
and loads no shared secret. `DropVideoConversionDeployment.json` permits only
its function/versions, the `dropVideoConversionInvokerLoop-prod` stack, the
`dropvideoconversioninvoke*-serverlessdeploy*` deployment-bucket prefix, its
log group, the `DropsVideoCreated-prod` rule, its OOM alarm, the two
`/6529/workload/*` parameters its definition resolves, and the regional
template-validation, log-group and alarm description APIs, all in `eu-west-1`.
The deployment-bucket prefix also matches the retired main-account staging
stack's bucket until that stack is removed; it grants no application-data
access.

The document is 5,044 compact characters, which exceeds the remaining
10,240-character inline budget of this role, so install it as an eleventh
customer-managed policy (the account's managed-policies-per-role quota is 20)
through the administrative identity after Access Analyzer validation and
positive/negative simulation.

The stack also owns the `drop-video-template-read-prod` inline policy on
`lambda-vpc-role`. As with the other IAM-owning stacks above, this role cannot
write role policies, so the stack's first creation (or any change to that
policy) is an administrative deployment. Later code and configuration updates
use the ordinary `Deploy a service` workflow.

## Signed record log worker

`signedRecordLogLoop` runs two scheduled functions in `us-east-1` on
`lambda-vpc-role`: `signedRecordLogCloser` every 5 minutes and
`signedRecordLogArchiver` hourly at minute 7.
`SignedRecordLogProductionDeployment.json` permits only those two functions and
their versions, the `signedRecordLogLoop-prod` stack, the
`signedrecordlogloop-pro*-serverlessdeploy*` deployment-bucket prefix, the two
log groups with their out-of-memory metric filters, the two schedules
`signedRecordLogLoop-prod-close` and `signedRecordLogLoop-prod-archive`, and the
two out-of-memory alarms (`signedRecordLogLoop-prod-<function>-OOM`), all in
`us-east-1`. The schedule names are declared in the worker definition, because
CloudFormation would otherwise truncate the stack name in generated rule names.
The bucket prefix allows CloudFormation's truncated stack component and
generated suffix; it grants no application-bucket access and no direct
invocation.

`SignedRecordLogProductionDeployment.json` has `ACCOUNT_ID` where the account id
goes. Replace it with the account id, as in the sibling files, before validating
and installing. Its manifest entry measures the committed file's compact JSON,
placeholder included; with the id filled in, the document is 4,877 compact
characters. The role's inline budget is 10,240 characters in total and the two
inline worker policies above already use most of it, so install this one as a
customer-managed policy named `SignedRecordLogProductionDeployment` and attach
it to this environment's deployment role (the account's
managed-policies-per-role quota is 20). Install it through the administrative
identity after Access Analyzer validation and positive/negative simulation. The
existing managed policies, trust policy and runtime role remain unchanged.
Deploy through the ordinary GitHub workflow afterward.
