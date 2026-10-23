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

## Waiting and processing failures

The existing worker also receives the named
`release-note-publication-recovery-prod` EventBridge rule every five minutes.
It processes up to ten due jobs, stops when less than 45 seconds remain, and
shares the function's reserved concurrency of one with SQS invocations.

An unfinished earlier job in the same repository/workflow/branch/environment
blocks a later job even before GitHub settles the earlier workflow. Desktop
release branches share one stream. GitHub run numbers are verified before
publication; invalid metadata is retained as `REJECTED` and never used to
publish a forged failure alert. Existing durable publications also retain their
ordering guard. A normal ordering result is returned by the transaction and
becomes a typed deferral outside it, rather than a database-failure alert.

Waiting for a workflow or predecessor defers the job five minutes without
incrementing `failure_count`. A processing failure leaves the job `PENDING`,
preserves its publication baseline and part receipts, and backs off from one
minute to one hour. A longer dependency `Retry-After` is respected. GitHub
requests first make up to three short, bounded attempts for transient server or
network failures; request-path and GitHub request-id diagnostics identify the
failed lookup without exposing credentials.

After five processing failures the worker posts a recovery-required alert once
and continues retrying the saved request. Exhausting SQS deliveries no longer
removes these jobs from the recovery path. Permanent content/history errors
remain `FAILED`, retain the original payload, and require operator review;
their failure-alert delivery is retried separately at five-minute intervals. An alert-delivery failure does not abort recovery of other saved jobs or unrelated streams. No recovery path deletes an
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
before requesting another attempt. Scheduled recovery and this operator path
are production-only.

The new table does not reconstruct envelopes for jobs exhausted before this
worker was deployed. For those jobs, inspect and replay the exact original DLQ
payload through the source queue in publication order. That creates the durable
recovery record. Preserve payload identity and never set a publication complete
merely to bypass its ordering guard. The DLQ retains transport failures for
14 days; saved recovery jobs do not depend on queue retention.

## Rollout and rollback

An administrative identity must first install the reviewed
`ops/iam/backend-production/ReleaseNoteRecoveryDeployment.json` policy on the
production deployment role. It grants management of only the named recovery
rule; it does not grant the GitHub role permission to modify IAM.

Deploy `dbMigrationsLoop` to create the new table through TypeORM sync, then
deploy `releaseNotesGenerationLoop`. No API, frontend, or Desktop application
deployment is needed. The latter two applications keep their existing queue
notification contract.

When rolling back the worker, disable its recovery rule and preserve the table
and queued requests. The old worker does not drain durable recovery jobs;
inspect and recover pending jobs through an approved compatible worker before
retiring the recovery path. Do not drop the recovery table or release-note
publication tables as a rollback shortcut.
