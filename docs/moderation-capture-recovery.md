# Moderation capture recovery

Concurrent checks of the same REP category share a moderation item. Cache hits
still write evaluation history. Capture starts with an item upsert; finalization
must therefore lock that item before writing its evaluation. Retention must use
the same order, including expiration and historical audit/evaluation deletion.

Finalization resolves the immutable item ID with a non-locking read, locks the
item, and then applies the existing evaluation and latest-completed-result
updates. Overrides, review state, policy versions and evidence retention keep
their existing rules. The provider is never rerun by a database retry.
If a concurrent purge removes the item before finalization acquires it, capture
fails closed with the existing safe failure instead of claiming that an
assessment was durably recorded. It is not treated as a successful no-op.

Retention discovers at most 1,000 candidate rows per cleanup phase without
holding evaluation locks. It groups candidates by item and processes one item
per transaction, locking the item and rechecking the candidate's eligibility.
Deleted items and evaluations completed since discovery are skipped. Routine
history purge already acquires item locks before deleting child history.

The four per-item phases (interrupted evaluations, expired results, old audits,
and old evaluations) each discover at most 1,000 rows. Each phase therefore
opens at most 1,000 item transactions, or at most 4,000 across the phases, plus
the existing routine-purge transaction. Multiple candidates for one item share
one transaction. All writers must keep the global item-before-child lock order;
sorting item IDs alone is not a substitute for that rule.

`dbMigrationsLoop` calls `retain()` once per invocation. Its configured schedule
is daily, its concurrency is one, and its timeout is 900 seconds shared with the
loop's other maintenance. It does not drain retention to quiescence in one run.
Committed cleanup removes rows from that phase's candidate predicate, so later
daily invocations resume discovery without a cursor. For example, 1,001 expired
results require at least two passes; existing integration coverage checks this.
New arrivals can outpace cleanup, so this is not a guarantee against backlog or
starvation under sustained load.

The transaction-count bound is not a wall-clock guarantee. Worst-case production
runtime under a large, contended backlog has not been established. After rollout,
check maintenance duration and oldest eligible retention age as well as capture
success; persistent backlog or proximity to the loop deadline requires a
separate retention-throughput/time-budget change, not a larger Lambda timeout.

## Recovery boundary

Standalone `start` and `finish` each use the existing SQL execution-budget owner:

- Five seconds total across attempts, including acquisition and cleanup.
- 1,500 ms maximum per statement and a one-second session lock-wait limit.
- 500 ms reserved for transaction finalization; session settings are restored
  before a connection is reused, or the connection is discarded.
- At most three attempts, with 20–49 ms randomized backoff, only after a WORK
  deadlock with COMMIT not sent and no connection destruction. The budget owner
  has awaited rollback before this error reaches the retry wrapper.

Raw errors, connection destruction, lock-wait timeout, and uncertain commit
outcomes are not replayed. They remain failed requests with the existing safe
capture error, including 503 for budget exhaustion and known transient codes.
When a caller supplies a transaction, it retains lifecycle and retry authority;
capture never retries just one statement within that transaction.

These are capture-unit limits, not a new end-to-end request deadline. They do
not bound provider latency or the later rating-write transaction. The separate
rating/proxy/identity timeout problem requires its own transaction and durable
notification-delivery work. This change introduces no schema or queue changes.

## Diagnostics and alerts

Warnings include fixed operation names, an allowlisted database code, attempt,
phase and commit outcome. Driver messages, SQL values, category text, identity,
evidence, and provider output are never copied into these diagnostics. Unknown
driver codes become `UNKNOWN`.

Moderation review queries opt into binding the issuing async context. This
preserves both the request ID and operational reporting state across pooled
socket reuse,
so the existing final-5xx guard recognizes a lower-layer report. Unreported 5xx
responses still emit their fallback alert. Recovery attempts can still produce
SQL error envelopes; this change does not globally suppress database errors or
change alert fingerprint policy.

## Deployment

Deploy compatible retention code in `dbMigrationsLoop`, then `api` (`seizeAPI`).
No schema synchronization or data migration is required. Mixed versions can
still contend until both are updated; API deadlock recovery is deliberately
bounded and is not a guarantee of success under sustained contention. Other
services retain their existing callback behavior unless their query opts into
binding. The capture/finalization and retention behavior changed here is owned
by these two units.

After an authorized rollout, verify the release and compare REP response
failures, operation-specific lock errors/retries, row-lock load, and duplicate
envelopes per request during representative traffic. A quiet interval does not
establish recovery. No Lambda timeout or AWS pool configuration change is part
of this fix.
