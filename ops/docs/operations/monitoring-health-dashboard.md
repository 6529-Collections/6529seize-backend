# Operational health dashboards

The monitoring account hosts a separate `seize-monitoring-{environment}-health`
CloudWatch dashboard for each environment. Its metric widgets read local
monitoring signals and verified application metrics from their source account
and region. This is a native cross-account, cross-region dashboard; same-region
OAM linking alone does not enable the production request widgets.

## Reading the dashboard

- **Pipeline heartbeat age:** scheduled canaries have traversed each alert
  queue and dispatcher. The 180-second line is the freshness limit. It does
  not establish that application jobs completed successfully.
- **Endpoint checks:** the existing Probe Lambda emits `ProbeSuccess` and
  `ProbeFailure` as explicit 0/1 samples, plus `ProbeDurationMilliseconds`.
  A sample includes response-status and configured JSON assertions. Time is
  measured with a monotonic clock and bounded to 0–60,000 milliseconds; HTTP
  requests retain their five-second timeout. Durations include failed attempts
  and assertion parsing and do not measure real-user page latency.
  Observations are captured before state changes and flushed once in `finally`,
  after alert/state work. The reused metrics client makes one attempt with a
  two-second total publication deadline, even with ten targets. State failures
  retain already collected observations; publication failures cannot replace
  the original state failure or interrupt the preceding uptime alerts.
- **Queue and delivery health:** oldest message age, visible/in-flight/delayed
  backlog, all three DLQs, delivery failures and admission overflow distinguish
  delayed work from rejected work. The archive collector drains DLQs, so zero
  backlog does not mean no failures occurred. Target-metric publication failures
  have a separate counter and do not prevent the existing uptime alert.
- **Actual API requests:** `AWS/ApiGateway` metrics use the observed REST API
  `ApiName` and `Stage`. `Count` uses `SampleCount`; `5XXError` uses `Sum`.
  Total `Latency` and `IntegrationLatency` show p50/p95/p99 in milliseconds.
- **Actual production website requests:** `AWS/ApplicationELB` metrics use
  verified `LoadBalancer` and `TargetGroup` dimensions. Target response time
  shows p50/p95/p99 in seconds, through the start of response headers. The
  target error rate uses routed request count. Separate load-balancer 5xx and
  unhealthy/healthy target counts expose failures before target selection.
- **Staging website:** the verified deployment has no equivalent ALB request
  series. Its dashboard identifies this gap and shows synthetic checks; it
  does not infer native traffic latency from those checks.

The dashboard defaults to six hours at one-minute resolution. Missing telemetry
and periods without requests are not evidence of uptime. No `FILL` expression
manufactures healthy samples; request rates require a positive observed request
count. AWS can emit sparse error counters, so read error-rate graphs alongside
request counts, endpoint probes and pipeline freshness. Probe success is the
fraction of observed attempts, not an availability SLO over unobserved time.
Probe search widgets discover recently published `Environment`/`Target` series;
removed target names may remain discoverable for CloudWatch's search window.

Only the bounded operator-defined target name becomes a metric dimension.
URLs, response bodies, headers, exception text and moderation evidence are not
published. At most ten configured targets add thirty metric series per
environment. Metrics and dashboards have AWS usage charges.

## Developer access

An account owner separately deploys `access-monitoring.json` in the monitoring
account and `access-source.json` in the application account. These privileged
access stacks are not part of the runtime OIDC deployment and do not grant
runtime roles permission to change IAM. Keep approved user principal ARNs and
operator usernames only in private deployment parameters.

`6529-MonitoringAdmin` provides full monitoring-account administration to the
explicitly approved existing administrator principals. `6529-MonitoringOperator`
provides monitoring management: dashboard/alarms, RUM and Synthetics capabilities.
It cannot manually override alarm state with `cloudwatch:SetAlarmState`.
Native alarm acceptance uses metric-driven evaluation with a separately
authorized release identity.
Both trusts require the exact source principal ARN and MFA. Operator permissions
do not include Secrets Manager reads, IAM role administration, Lambda code
updates or blanket `iam:PassRole`. New canary execution-role setup therefore
requires an administrator to provide a separately reviewed role/grant; the
Synthetics API permission alone does not make arbitrary canary creation work.
An approved administrator's compromised credentials can affect both accounts;
MFA and explicit trust reduce but do not remove this shared identity risk.

The monitoring console uses the AWS service principal
`cloudwatch-crossaccount.amazonaws.com` with
`/service-role/ServiceRoleForCloudWatchCrossAccountV2`. It can assume only the
configured source account's `CloudWatch-CrossAccountSharingRole`; the source
role trusts only that exact broker ARN and grants metric/alarm reads. This
does not share application logs, secrets or application write access. OAM is
not substituted for this cross-region console path.

Before creating either access stack, inventory the two fixed broker/sharing role
names. If either already exists outside the intended stack, inspect its trust,
permissions and ownership and use a separately reviewed import/adaptation plan.
Do not delete or replace a console-managed role to make creation succeed. These
templates create the roles; they do not silently adopt existing resources.
Principal ARN lists and `OperatorUserNames` must be nonempty, and operator names
must refer to existing source users; the parameter patterns reject empty entries.
The deployment configuration is intentionally scoped to the commercial AWS
partition. Region validation does not claim support for isolated partitions.

Resource-capable reads/writes are scoped to their own account's dashboards,
CloudWatch tags, RUM app monitors, SNS topics and Synthetics canaries/groups.
The remaining wildcard-resource statements are explicit AWS API requirements:
metric/discovery reads and composite-alarm history, anomaly detectors, composite
alarm creation, RUM list/tag discovery, SNS topic discovery and Synthetics
creation/discovery. Synthetics creation still requires separately approved
execution-role passing. CloudWatch composite-alarm APIs need wildcard permission
even when other alarm operations are scoped to account alarm ARNs.

Policy simulation and template validation do not establish a successful human
login. After deployment, an intended administrator and operator must separately
verify MFA role switching and dashboard visibility. Offboarded identities must
be removed from both source permissions and the monitoring trust parameters.

## Configuration and rollout

1. Merge and deploy the isolated monitoring runtime update in staging, then
   production after validation. It updates the existing monitoring artifact;
   no application Lambda, API or database deployment is required for probe
   metrics. The existing source collection stack remains intact.
2. Establish the reviewed native CloudWatch console sharing roles and monitoring
   viewer/operator/admin access. IAM access is separate from these dashboard
   templates. Runtime Lambdas do not receive cross-account metric-reading or
   IAM privileges. Organization administrators retain their administrative
   reach; the dashboard does not change that failure boundary.
3. Discover `Probe` and the `NormalDeadLetters`, `CriticalDeadLetters` and
   `EventDeadLetters` physical resource names from the matching monitoring
   CloudFormation stack. Resolve the API domain mapping and verify its observed
   CloudWatch dimension set, including its region. In production also verify
   the active website ALB and target group. Keep actual identifiers in operator
   configuration, not in the repository.
4. Deploy `ops/monitoring/dashboard-{environment}.json` as a separate
   `seize-monitoring-{environment}-dashboard` CloudFormation stack in the
   monitoring account, in the same region as the monitoring runtime. Supply
   every parameter from the verified inventory:
   `SourceAccountId`, `SourceRegion`, `RestApiName`, `RestApiStage`,
   `ProbeFunctionName`, the three `*DeadLettersName` values, and production-only
   `WebsiteLoadBalancer`/`WebsiteTargetGroup` full dimension values. An API ID,
   ALB ARN or target-group ARN is not the corresponding metric dimension.
5. Use a reviewed changeset and the authorized deployment identity. Dashboard
   management requires `cloudwatch:PutDashboard`, `GetDashboard` and
   `DeleteDashboards` on its exact global dashboard ARN. Source metric access
   requires the separate sharing/viewing path. Do not grant runtime roles this
   access or reuse application deployment credentials in monitoring.
6. Open the dashboard as an intended dev role. Verify both local and source
   widgets can retrieve data. Check actual CloudWatch dimension/statistic data,
   units and timestamps against the displayed series. An empty request series
   must be explained by verified idle traffic or marked as a telemetry gap.
   Check healthy and controlled failed probe samples, both lane age series and
   DLQ resource bindings. Validate grants independently as each role; an
   administrator's successful view does not prove a developer can view it.

From `ops/monitoring`, regenerate with `../../bin/6529 run generate` and validate
with `../../bin/6529 run generate:check` and `../../bin/6529 run check`. The source
of truth for dashboard layout is `scripts/dashboard.mjs`; do not edit generated
dashboard JSON manually. Schema checks also validate both dashboard templates.

Dashboard rollback removes or restores only the separate dashboard stack. To
roll back probe measurements, redeploy the prior exact monitoring artifact;
existing queued alerts, receipt state and archive remain. Historical custom
metrics follow CloudWatch retention. This dashboard does not replace independent
outside-AWS uptime/dead-man coverage or true business-job completion heartbeats.

## AWS references

- [Cross-account, cross-region dashboard fields](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Dashboards.html)
- [Dashboard body syntax](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Dashboard-Body-Structure.html)
- [REST API metric dimensions and statistics](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-metrics-and-dimensions.html)
- [Application Load Balancer metric dimensions and statistics](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html)
- [CloudWatch IAM actions and resources](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudwatch.html)
- [CloudWatch composite-alarm permission requirements](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/permissions-reference-cw.html)
- [RUM IAM actions and resources](https://docs.aws.amazon.com/service-authorization/latest/reference/list_rum.html)
- [Synthetics IAM actions and resources](https://docs.aws.amazon.com/service-authorization/latest/reference/list_synthetics.html)
