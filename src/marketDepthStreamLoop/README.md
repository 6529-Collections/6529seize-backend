# OpenSea market event stream

The scheduled worker discovers the same collections as the REST poller. It
subscribes to listings, item bids, collection/trait offers, cancellations,
sales, and order invalidation/revalidation through `@opensea/sdk/stream`.
Each normalized event retains its original stream envelope and stream source
evidence. REST and stream observations use the shared lifecycle identity.

The schedule runs every 600 seconds with reserved concurrency 2. Each run has
a 650-second budget: up to 635 seconds of capture and 15 seconds reserved for
shutdown and persistence. The capture windows ordinarily overlap by about 35
seconds to accommodate startup and scheduling jitter. The actual deadline also
reserves five seconds before the Lambda's remaining timeout for DB teardown;
the configured Lambda timeout is 900 seconds. Stream cursor and completeness
watermark values stay null, so overlapping appends retain the same cursor
precondition. Database event uniqueness makes duplicate observations idempotent.

Capture is best effort. The SDK reconnects/rejoins after transport errors, but
the stream offers no replay cursor and the SDK's public client does not expose
subscription acknowledgements. Network failures or unusually late invocations
can still leave gaps. REST reconciliation and snapshots remain necessary; a
quiet run does not prove that every subscription was live.

The buffer is limited to 1,000 events and 16 MiB, with a bounded cache of 4,000
recent event identities. Accepted events stay queued until a batch of at most
50 is confirmed. Completed pre-commit write failures receive at most three
attempts per flush, with one further flush pass after capture stops. Each attempt
waits for transaction cleanup before retrying. Shutdown unsubscribes,
attempts a bounded disconnect, then drains accepted events even after callback
or subscription errors. Buffer overflow, malformed event handling, exhausted
retries, and incomplete draining fail the invocation visibly.

Each stream database operation uses the SQL owner's monotonic five-second budget,
shortened to the remaining run budget, with one second reserved for finalization.
The SQL owner bounds acquisition, statements, commit and cleanup, disposing of a
stalled connection before returning. The runtime awaits that result before
closing the database context; it does not abandon a SQL promise on a separate
timer. The budget is opt-in for stream appends; REST writers keep their existing
transaction behavior. Each transport disconnect remains bounded to two seconds.

An unacknowledged COMMIT remains uncertain even after connection disposal. The
runtime leaves that batch unconfirmed and does not retry or final-drain it during
the invocation. A save aborted before COMMIT can be retried after cleanup, using
the same lifecycle IDs. An acknowledged commit stays confirmed even if session
cleanup requires discarding its connection. Transport error objects and authenticated socket
URLs are never logged; the worker logs only static recovery messages and run
counts for accepted, persisted, duplicate, pending, and transport-error events.
