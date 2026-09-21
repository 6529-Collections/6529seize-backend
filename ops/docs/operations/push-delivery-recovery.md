# Push delivery recovery

## Signals and classification

Use the verified application account and region for the selected environment.
Inspect Lambda release tags, queue attributes and CloudWatch metrics before
attributing a regression to a release. Lambda Errors can stay zero while SQS
partial failures exhaust retries. `PushNotificationsAge` covers 30-minute oldest
message age in three of five minutes; `PushNotificationsDeadLetters` covers any
visible DLQ message. These alarms use the existing protected alarm forwarding path.

`PUSH_RETRY_EXHAUSTED` means a failed item was received at least eight times, close
to the current ten-receive limit. A bounded lock collision is a warning and still
returns a partial failure. `PUSH_PROVIDER_TRANSIENT` retries. A first
`PUSH_SENDER_MISMATCH` remains an error, followed by a 24-hour quarantine of the
exact device/token/project tuple. Correct the client's Firebase project/environment
or re-register with a valid token; do not delete every registration for a profile.
Same-token repairs may wait for quarantine expiry. A rotated token is immediately
eligible. Never include tokens, credentials or notification bodies in incident chat.

## Existing dead letters

Queue attributes and aggregate logs are read-only. Receiving an SQS message changes
visibility and receive count; console polling is also a receive. Obtain explicit
operational authorization for payload inspection, export, deletion or redrive.
Do not bulk redrive to diagnose the contents. Retention continues while waiting;
capture timestamps and plan evidence retention promptly without claiming that queue
depth identifies a cause or number of affected people.

After authorized bounded inspection, classify each payload: ordinary notification
ID, profile badge refresh, installation badge refresh, malformed or unknown. Check
original age, source/dead-letter timestamps and receive counts. Preserve evidence
under approved restricted storage rather than pasting message bodies into tickets.

Before an authorized recovery, deploy and verify the relevant fix, resolve sender
configuration and check main-queue health. Badge jobs resolve current registrations
and recalculate counts; never replay a captured numeric badge. Ordinary notifications
recheck current read/access/mute state. Receipts prevent confirmed device replay only
while Redis state survives its eight-day retention. Messages sent before receipt
support, ambiguous provider outcomes and older messages can replay visible alerts.
Choose recovery scope with that risk understood; do not indiscriminately redrive
all historic notifications. Unknown/malformed work requires separate diagnosis.

Use a small authorized recovery first, checking failed-item counts, queue age, DLQ
movement and condition-specific errors before expanding. A code PR neither clears
existing dead letters nor proves that suppressed targets have been repaired.

## Rollout and rollback

Deploy the isolated monitoring runtime (condition parser and dispatcher), then
its source stacks (push backlog/DLQ alarms), then `pushNotificationsHandler`.
There is no schema, API, queue topology or frontend change. The shared operational
envelope extension only appears for the four new push conditions; other services
do not require immediate redeployment. Older monitoring readers ignore the additive
field. Existing queued summaries remain compatible after upgrade. On monitoring
rollback, drain versioned hourly checkpoint work before reverting to a dispatcher
that does not understand it; otherwise it can send premature duplicate summaries.
Reverting the worker restores old retry behavior and ignores the new Redis keys,
which expire automatically. It can reintroduce visible duplicates and mismatch churn.
