# Recovering release-note publications

Per-run production publications with one service and a valid run number are
saved in `release_note_recovery_jobs` before publication starts. This includes
Frontend and Desktop release streams. PR-scoped backend groups retain their
existing service-group completion and SQS retry policy.

The saved envelope is immutable and keyed by the existing deterministic
publication id. Duplicate queue deliveries cannot reset its attempts, overwrite
its original request, or restart a completed publication. Redis still
coordinates recent attempts; durable drop metadata remains the publication
receipt. Recovery always runs through the normal generator and receipt checks.

## On-demand recovery

The worker runs only for real SQS messages and explicit operator invocations.
There is no periodic trigger or idle polling. Pending work queues a delayed
message containing its saved envelope on the existing `release-note-generation`
queue before acknowledging the current delivery. A failed queue handoff fails
the invocation, leaving the current delivery subject to normal SQS retries and
the existing DLQ. The saved job remains available for operator recovery if
transport retries themselves are exhausted.

SQS delays are capped at 15 minutes. If a saved retry deadline is further away,
the message hands off another bounded delay without attempting publication
before that deadline. Successful or terminally alerted jobs enqueue no further
retry of themselves. Reserved concurrency remains one across queued and operator
invocations.

Automatic handoffs carry a `ReleaseNoteRetryHops` SQS message attribute and stop
after ten hops across the whole chain, including successor wakeups and long
waits. This stays below Lambda's recursive-loop guard without disabling it or
changing IAM. If the budget is exhausted, the handoff fails with an explicit
operator-recovery diagnostic. The current message remains subject to the normal
SQS/DLQ policy, and all unfinished jobs remain saved. Use the explicit operator
retry below to start a fresh bounded chain after investigating; bulk redrive
preserves message attributes and does not reset this budget.

## Waiting and processing failures

An unfinished earlier job in the same repository/workflow/branch/environment
blocks a later job even before GitHub settles the earlier workflow. Desktop
release branches share one stream. GitHub run numbers are verified before
publication; invalid metadata is retained as `REJECTED` and never used to
publish a forged failure alert. Existing durable publications also retain their
ordering guard. A normal ordering result is returned by the transaction and
becomes a typed deferral outside it, rather than a database-failure alert.

Waiting for a workflow defers its retry five minutes without incrementing
`failure_count`. A later run encountering an earlier saved job parks itself and
uses the real delivery to resume the predecessor. Completing that predecessor
queues the next pending run in stream order. Later jobs do not repeatedly wake
to poll a permanent blocker; an operator must review/retry that blocker.
A processing failure leaves the job `PENDING`,
preserves its publication baseline and part receipts, and backs off from one
minute to one hour. A longer dependency `Retry-After` is respected. GitHub
requests first make up to three short, bounded attempts for transient server or
network failures; request-path and GitHub request-id diagnostics identify the
failed lookup without exposing credentials.

After five processing failures the worker posts a recovery-required alert once
and continues retrying within the bounded handoff budget. Exhausting SQS
deliveries never deletes the saved recovery request; operator recovery may be
required if the transport or handoff budget is exhausted. Permanent content/history errors
remain `FAILED`, retain the original payload, and require operator review;
their unfinished failure-alert delivery queues its own bounded delayed retry.
An alert-delivery failure does not abort explicit recovery of other saved jobs
or unrelated streams. No recovery path deletes an
unfinished publication, advances its cursor manually, or silently skips content.

The first-ever run of a stream may have no earlier successful deployment from
which to build a publication range. That pre-existing bootstrap case is retained
as `NO_BASELINE`, with a specific alert, rather than as a permanent blocker. No
publication exists to complete or bypass. A later deployment can bootstrap from
the first successful run normally. Initial-baseline alert delivery is retried
without trying to generate a nonexistent range.

## Operator recovery

Use the normal wave API and CloudWatch logs to inspect the run, publication
receipt metadata (`release_note_id`, repository, SHA, run number), generated part
count, and successful invocation completion. A transport message in the DLQ
must be identified before replay. Recover the earliest unfinished run first,
confirm its receipt and completion before recovering the next, and remove only
the successfully recovered original DLQ message. Do not bulk redrive an ordered
backlog or author release notes by hand.

Jobs saved by this worker can be explicitly retried by an authorized operator
invoking `releaseNotesGenerationLoop` with:

```json
{"recover_publication_id":"<64-character publication id>"}
```

This selects only that job, resets its retry schedule, and reuses its saved
request, publication baseline and receipts. Unknown ids fail clearly. Completed
jobs remain completed. Review the cause of a permanent or rejected failure
before requesting another attempt. Operator recovery is production-only and
starts a fresh handoff budget. An operator can also invoke
`{"recover_due":true}` to resume up to ten saved due jobs with a 45-second
remaining-time budget. This is an explicit action, not an automatic trigger.

The new table does not reconstruct envelopes for jobs exhausted before this
worker was deployed. For those jobs, inspect and replay the exact original DLQ
payload through the source queue in publication order. That creates the durable
recovery record. Preserve payload identity and never set a publication complete
merely to bypass its ordering guard. The DLQ retains transport failures for
14 days; saved recovery jobs do not depend on queue retention.

## Rollout and rollback

No new IAM policy or EventBridge resource is required. The existing queue
policy already grants the worker role `sqs:GetQueueUrl` and `sqs:SendMessage` on
its source queue.

Deploy `dbMigrationsLoop` to create the new table through TypeORM sync, then
deploy `releaseNotesGenerationLoop`. No API, frontend, or Desktop application
deployment is needed. The latter two applications keep their existing queue
notification contract.

When rolling back the worker, preserve the table and queued requests. The old
worker does not drain durable recovery jobs;
inspect and recover pending jobs through an approved compatible worker before
retiring the recovery path. Do not drop the recovery table or release-note
publication tables as a rollback shortcut.
