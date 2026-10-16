# WebSocket delivery recovery

An individual 429 is a delivery warning and metric, not a Discord error alert. AWS uses the same 429 for request throttling and a full listener buffer; do not claim a specific cause from one response. Diagnostics contain a connection hash, frame type and SDK metadata. They never contain raw connection IDs, frames, JWTs or exception text. Normal 403, validation and server failures retain error reporting.

## What happens automatically

After bounded SDK attempts, the shared sender pauses the connection for roughly 30 seconds, doubling delays up to five minutes with jitter. All producer Lambdas share that state. Later refresh hints collapse into one marker per connection. Healthy sends remain concurrent. The recovery worker runs every minute and retries due markers with at most ten concurrent sends and 100 markers per invocation. Only a generic request to refetch authorized HTTP state is persisted, so retries cannot replay business effects or leak formerly authorized content.

The browser staggers and combines refreshes, refetches active queries and leaves inactive queries stale until needed. It also reconciles after reconnect and foreground resume. Authentication acknowledgements are never substituted with refresh markers. Confirmed sends reset the failure streak while preserving any still-needed refresh. A listener with at least three consecutive failed sends spanning two minutes can be closed only when at least three peers are healthy and the fleet is not degraded. AWS must confirm closure before the subscription is deleted. Server-initiated normal closure reconnects through the client's existing jittered backoff.

## Respond to an alert

1. Open the latest `WS_DELIVERY_HEALTH` summary in `/aws/lambda/webSocketDeliveryLoop` in the alerted environment. Compare attempted/sent/throttled/deferred counts, distinct connections, pending count, oldest failure and health classification. Metrics in `6529/WebSocketDelivery` have only the Environment dimension; never add connection IDs as dimensions.
2. `widespread_throttling`: inspect API Gateway account/region send quotas and broadcast volume. Check whether several Lambdas are contributing and reduce redundant broadcasts or sender concurrency. Broad 429s suggest shared throttling, but are not proof of a particular AWS limit. Do not disconnect the fleet.
3. `persistent_outage`: no listener has had a successful send in two minutes while pending work persists. This also catches a one-listener audience. Check AWS transport availability, permissions and Redis. Previously successful traffic does not suppress this condition.
4. `recovery_backlog`: at least 100 markers remain and the oldest has waited five minutes. Check worker errors, its schedule/reserved concurrency, throughput and Redis latency before increasing capacity.
5. A worker or recovery-store alarm means automatic repair is not reliable. Restore the worker/schedule or Redis; inspect Failed and RecoveryUnavailable metrics. A missing marker is not proof of delivery. Direct sends may still succeed during a Redis outage.
6. Confirm the queue drains, successful sends resume and the CloudWatch alarm returns to OK. Individual warnings for a blocked listener need no operator action while peer delivery stays healthy.

Degraded is raised over a rolling five-minute window when at least five distinct listeners have failed, at least ten sends have throttled, and either 20% of listeners, 5% of sends or 100 sends are affected. It also covers the persistent-outage and backlog conditions above. Two consecutive one-minute Degraded datapoints produce one alarm transition, followed by recovery. Worker heartbeat is checked over two five-minute periods; repeated recovery-store failures require at least ten failures in each of two one-minute periods. Missing API Gateway 429 metrics must never be interpreted as absence of throttling.

## Rollout and rollback

The monitoring deployment workflow verifies its public `/health` endpoint after the stack update. This checks fresh queue receipts and webhook connectivity without creating synthetic alerts.

Deploy monitoring rendering/allowlists, provision the new worker's narrowly scoped deployment permissions, deploy `webSocketDeliveryLoop`, and register its source log subscription before deploying senders. Deploy every sending service listed in the release PR, then the frontend. No schema migration or REST API contract change is required. The new frame is additive; older browser bundles retain existing best-effort behavior until refreshed. Updated browsers repair missed state after connection recovery.

Redis keys use the endpoint-scoped `ws-delivery:v1` namespace and expire after one hour without activity. Roll back sender code through ordinary deployments while leaving the worker and pending state in place until it drains. Never delete subscription state or widen permissions to hide a rate-limit error.

Current sending services are `api`, `attachmentsOrchestrator`, `attachmentsProcessor`, `delegationsLoop`, `dropMediaSanitizer`, `helpBotReplyLoop`, `mintAnnouncementsLoop`, `nftLinkRefresherLoop`, `nftsLoop`, `pushNotificationsHandler`, `releaseDigestLoop`, `releaseNotesGenerationLoop`, `subscriptionsDaily`, `subscriptionsTopUpLoop`, `transactionsProcessingLoop`, and `waveDecisionExecutionLoop`. Redeploy each for a shared sender change, plus the recovery worker. Preserve environment-specific outbound handlers present on staging and include them when they use the shared transport. Follow actual consumer/producer dependencies; unchanged schema and unrelated indexing Lambdas do not need redeployment.
