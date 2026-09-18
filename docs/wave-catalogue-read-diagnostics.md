# Wave catalogue Redis read diagnostics

The API emits one structured `[WAVE_CATALOGUE_READ]` event for a sampled access
to the shared wave-group catalogue. Sampling is decided **before** the Redis GET,
so selection does not depend on how long the GET takes. It covers hits, misses,
GET errors and JSON parse errors. The event is emitted when the GET and any hit
parse finish, before a miss refills from the database. The existing cache key,
TTL, refill, invalidation and eligibility behavior are unchanged.

## Enable and bound sampling

Set `WAVE_CATALOGUE_READ_SAMPLE_RATE` to a decimal from `0` through `1` in the
API runtime configuration. Missing, invalid, negative or greater-than-one
values disable sampling. Start at `0.01` (one percent). The code also caps output
at **60 samples per minute per process** and at **8 simultaneous event-loop
monitors per process**. A sampled event still logs if the monitor cap is reached;
`event_loop_monitor_active` is false, its delay sample count is zero and delay
maximum is null. Sampling is per read,
not per user or request. A busy process reaching the cap samples at a lower
effective rate; compare counts by time bin and do not extrapolate capped bins.

No Redis command or cache payload is added. Every catalogue read checks the
configured rate, makes a cryptographic random selection when sampling is
enabled, and updates a process-local counter. Selected reads scan the returned
string to measure its UTF-8 bytes, start one 20 ms event-loop-delay monitor
during the GET, and emit one log line. The byte scan happens after the measured
GET and before the measured JSON parse. The monitor is disabled when that GET settles,
so it cannot accumulate idle Lambda freeze/thaw time between requests. The
per-minute log cap also resets after a long idle period. All connection counts
are event deltas during the read, rather than ages since the last event.

The event contains `request_id` from the API logging context for correlation.
It deliberately omits profile IDs, wallet/JWT subjects, group names, criteria,
catalogue data, credentials and raw errors. A null request ID means the access
had no API request context. The event is written directly to standard output
because the general logger prefix includes the JWT subject.

## CloudWatch Logs Insights

Run these against `/aws/lambda/seizeAPI` in `us-east-1` over the desired UTC
window. Each query operates on sampled diagnostics, not the existing
slow-request-only timer reports. `samples` is the observed log count; it is
not an estimate of all reads. The first query shows the sample and error
population before interpreting percentiles.

```sql
filter @message like /\[WAVE_CATALOGUE_READ\]/
| parse @message /\[WAVE_CATALOGUE_READ\] (?<event_json>\{.*\})/
| fields jsonParse(event_json) as e
| stats count(*) as samples,
    count_distinct(e.request_id) as request_ids,
    pct(e.get_ms, 50) as get_p50_ms,
    pct(e.get_ms, 95) as get_p95_ms,
    pct(e.parse_ms, 50) as parse_p50_ms,
    pct(e.parse_ms, 95) as parse_p95_ms
  by e.cache_outcome, e.error_stage, bin(5m) as period
| sort period asc
```

Compare hit duration with payload size. The bucket is whole MiB; examine
counts as well as percentiles.

```sql
filter @message like /\[WAVE_CATALOGUE_READ\]/
| parse @message /\[WAVE_CATALOGUE_READ\] (?<event_json>\{.*\})/
| fields jsonParse(event_json) as e
| filter e.cache_outcome = "hit"
| fields floor(e.catalogue_bytes / 1048576) as catalogue_mib_bucket,
    e.get_ms as get_ms, e.parse_ms as parse_ms
| stats count(*) as samples,
    min(get_ms) as get_min_ms,
    pct(get_ms, 50) as get_p50_ms,
    pct(get_ms, 95) as get_p95_ms,
    pct(parse_ms, 50) as parse_p50_ms
  by catalogue_mib_bucket
| sort catalogue_mib_bucket asc
```

Compare durations with process-local overlapping reads and connection state.
`reconnect_during_read` is true only when the shared client emitted a
`reconnecting` event within that GET interval. Readiness is a snapshot at each
end, not proof of continuous readiness.

```sql
filter @message like /\[WAVE_CATALOGUE_READ\]/
| parse @message /\[WAVE_CATALOGUE_READ\] (?<event_json>\{.*\})/
| fields jsonParse(event_json) as e
| filter e.cache_outcome = "hit"
| fields e.max_concurrent_reads_during_read as concurrent_reads,
    e.redis_ready_start as ready_start,
    e.redis_ready_end as ready_end,
    e.redis_reconnect_events_during_read > 0 as reconnect_during_read,
    e.get_ms as get_ms
| stats count(*) as samples,
    pct(get_ms, 50) as get_p50_ms,
    pct(get_ms, 95) as get_p95_ms
  by concurrent_reads, ready_start, ready_end, reconnect_during_read
| sort samples desc
```

Compare GET time with the maximum measured event-loop delay during that GET.
Only rows with `event_loop_delay_samples > 0` have a delay measurement; retain
the count of unmeasured rows to avoid misreading null as zero.

```sql
filter @message like /\[WAVE_CATALOGUE_READ\]/
| parse @message /\[WAVE_CATALOGUE_READ\] (?<event_json>\{.*\})/
| fields jsonParse(event_json) as e
| filter e.cache_outcome = "hit"
| fields e.event_loop_monitor_active as monitor_active,
    e.event_loop_delay_samples as loop_samples,
    e.event_loop_delay_max_ms as loop_max_ms,
    e.get_ms as get_ms
| stats count(*) as samples,
    count(loop_max_ms) as measured_loop_samples,
    pct(get_ms, 50) as get_p50_ms,
    pct(get_ms, 95) as get_p95_ms,
    pct(loop_max_ms, 50) as loop_max_p50_ms,
    pct(loop_max_ms, 95) as loop_max_p95_ms
  by monitor_active, bin(5m) as period
| sort period asc
```

For individual sampled errors and their request correlation:

```sql
filter @message like /\[WAVE_CATALOGUE_READ\]/
| parse @message /\[WAVE_CATALOGUE_READ\] (?<event_json>\{.*\})/
| fields jsonParse(event_json) as e
| filter e.cache_outcome = "error"
| stats count(*) as sampled_errors,
    count_distinct(e.request_id) as request_ids
  by e.error_stage, bin(5m) as period
| sort period asc
```

## Interpretation and rollout

`get_ms` measures elapsed time around the Node Redis GET. It includes client
queueing, network, reply handling/string decoding and scheduling; it is not
server execution or network time alone. `parse_ms` is a separate synchronous
JSON.parse interval. `catalogue_bytes` is the UTF-8 size of the returned string,
not Redis wire bytes. `concurrent_reads_at_start` includes the current read;
`max_concurrent_reads_during_read` includes any additional catalogue reads
started in the same process while it was active. Neither represents fleet-wide
concurrency or all work on the shared Redis client. Event-loop delay is a
20 ms resolution sample of scheduler delay during GET, not a decomposition of
GET or network time. Short GETs can have no delay samples. A stalled synchronous
parse is shown by `parse_ms`; the delay monitor may not capture that stall.
Sampled errors are not a count of all failures.

Deploy the backend `api` service through the normal staging and production
sequence after review. Enable sampling in staging first, confirm event volume
and field shape, then enable one percent in production for a representative
window. Runtime configuration loaded at cold start can leave older warm
processes on their previous setting. To stop collection, set the rate to `0`
and roll the API deployment so warm processes reload it; reverting the API
revision also removes the instrumentation. No schema, migration, cache format
or frontend deployment is involved. Mixed API versions are compatible; older
instances simply emit no diagnostic events, so account for deployment overlap
when comparing sample counts. Do not infer a root cause solely from the initial
admin-host probe or slow-request-selected historical timers.
