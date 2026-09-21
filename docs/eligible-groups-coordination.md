# Legacy per-profile eligibility coordination

The legacy all-wave eligibility path retains its 60-second result cache and
existing permission rules. On a cache miss, an API instance acquires an
eight-second Redis lease for that profile. The owner rechecks the result after
acquisition, computes if still needed, and renews the lease every second.
Other instances poll the result at staggered 125–300 ms intervals. They reuse
only a result validated against a newly read profile-group change time and
wave-group version. If an owner fails or its lease expires, one follower can
acquire the lease and take over. No follower computes without ownership.

The request budget is 12 seconds from entry to the legacy cache path. After
that, callers receive HTTP 503 with a temporary-unavailability message. A
timed-out caller aborts lease renewal and releases its token; a late computation
cannot publish. Redis read, lease, and publication failures also fail closed
with 503 rather than starting uncoordinated computations. An owner error
releases its lease. This trades temporary availability for bounded work and
avoids turning an uncertain eligibility check into permission denial or a
stale permission grant. The frontend fetch helper surfaces a 503 as an error;
existing caller retry controls can issue a new request. It does not
automatically replay a write.

The repository's local/test database harness explicitly sets
`FORCE_AVOID_REDIS=true` and continues to evaluate rules directly without a
profile-result cache. That path is limited to `NODE_ENV=local` or `test`;
production cache misses still require Redis coordination and return 503 if it
is unavailable.

Group-save invalidation remains best effort after the database transaction
commits. A Redis failure there is logged; returning an error would invite a
retry of an already committed write. While Redis is unavailable, eligibility
reads fail with 503. After Redis recovers, the existing profile-change and
global-version checks still apply, and an entry missed by invalidation can
remain until its configured TTL. This is a pre-existing write-side freshness
limit during Redis outages.

The result key is unchanged. New results add an `invalidation` string to the
JSON; old readers ignore this extra field. New readers accept old results only
while no new-code invalidation marker exists for that profile. New lease and
invalidation keys use Redis hash tags that map to the existing result key's slot. Lua scripts
atomically check the ownership token before publication, renewal or release.
Profile invalidation increments a short-lived marker and deletes the result
in the same script; publication checks both token and marker. An expired owner
cannot overwrite a replacement owner, and an invalidated owner cannot publish
the result it computed before that invalidation. The caller also checks
profile-group change time and global wave-group version before computation,
after computation, and after publication. A changed input yields 503; the next
request can compute from current inputs. The lease does not grant permission
authority.

## Rollout and rollback

Only the `api` Lambda needs redeployment. During a rolling deployment, old API
instances continue using their literal `1` lock and brief fallback, so mixed
instances can still duplicate work temporarily. Both versions read the same
result key and the same profile/global freshness signals. New instances
also maintain the invalidation marker and reject old-format results after it
changes. The marker provides the stronger
in-flight guard once all API instances run the new code; old instances do not
write it. No migration, configuration change or frontend deployment is needed.
Rollback deploys the earlier API code. It ignores the new lease and marker
keys; leases expire within eight seconds without renewal. Markers expire after
the configured result TTL plus the request budget (72 seconds at the default
TTL), and the result cache remains compatible.

## Measurement

Preserve the one-percent `WAVE_CATALOGUE_READ_SAMPLE_RATE` production sampling
and use [the catalogue diagnostic guide](wave-catalogue-read-diagnostics.md)
to compare cache-hit GET duration and payload bytes. Compare `[ELIGIBILITY_READ]`
`computed` events per distinct profile and Lambda stream, plus `lock_wait`
reuse, `coordination: owner`/`takeover`, and
`[ELIGIBILITY_COORDINATION]` timeout/failure outcomes in matched traffic
windows. The diagnosed 10:05:40–10:05:46 UTC burst had 296 computations for
60 profiles across 281 streams; it is an illustrative baseline, not a
guaranteed reduction or evidence that every computation used identical input
versions. Monitor 503 rates and p95/p99 API latency alongside catalogue GET
timings. Redis metrics in that sample did not prove a fixed bandwidth or
capacity limit.
