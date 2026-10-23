# Shared Memes calendar

The canonical pure TypeScript module lives in the frontend at `shared/memes-calendar`.
This repository bundles a byte-identical copy in `src/memes-calendar`. Calendar
calculation requires no network, frontend availability, or package registry.
Craft uses it to resolve a claim's season, retaining the database creation-window check.
Subscription coverage and Help Bot next/current/specific-mint answers also calculate
locally. Shared query functions back the existing frontend calendar API as well.
No backend calendar consumer requires the frontend calendar HTTP service.

## Updating the calendar

1. Edit the canonical frontend module, including skips/reschedules there.
2. Bump `MEMES_CALENDAR_VERSION` for any behavior change.
3. From that checkout run `./bin/6529 run calendar:refresh`, then
   `./bin/6529 run calendar:sync <backend-checkout>`.
4. Run focused calendar tests in both repositories and commit both copies together.

`./bin/6529 run calendar:check` verifies the pinned SHA-256 manifest. Backend
build and test preparation also run it. Do not edit the vendored source directly.
Both repositories must carry the same version and manifest in paired changes;
the check detects local drift but cannot inspect an unmerged remote repository.

## Time policy

Mint dates retain the existing Monday/Wednesday/Friday cadence, history, and overrides.
All launch wall times are defined in `Europe/Athens` using IANA timezone data:
Phase 0 17:40–18:20, Phase 1 18:30–18:50, Phase 2 19:00–19:20, then public
19:20 until the next calendar day at 17:00. Preview is 17:15 and post-mint work
18:00 on that closing day. UTC offsets change with DST; no fixed UTC offset or
24-hour approximation determines the next day's closing time.

The launch integration must save the version, timezone and exact UTC phase times
when accepting a launch. A future calendar update must not move an accepted launch.

Sync prunes only unchanged obsolete files owned by the previous manifest, preserving
unrelated files and refusing local edits or paths outside the managed directory.
Future skips, extras and reschedules apply in both numbering directions; a skipped
day takes precedence over an extra-day override for the same date.
The existing date-based model counts each eligible UTC day once. Moving a mint
onto an already eligible date removes the source day without adding a second mint
on the destination day. Scheduling two distinct mints on one day would require a
different event model; an extra-day override does not provide that behavior.

## Existing-service rollout

After merging the paired calendar changes, redeploy `claimsBuilder` for claim
season resolution, `api` (the `seizeAPI` Lambda) for coverage reads,
`subscriptionsDaily` for coverage reconciliation, and `helpBotReplyLoop` for
calendar answers. These existing services are independent consumers; deploy them
before the frontend if rolling out the paired change.
There are no new Lambdas or schema changes in the calendar foundation.

`SUBSCRIPTION_COVERAGE_CALENDAR_BASE_URL`, `SUBSCRIPTION_COVERAGE_ENVIRONMENT`,
`SUBSCRIPTION_COVERAGE_SCHEDULE_TIMEOUT_MS`, and
`SUBSCRIPTION_COVERAGE_SCHEDULE_FAILURE_TTL_MS` are retired and may be removed
from environment configuration. Horizon (default 24, maximum 60) and cache TTL
(default five minutes, capped at the next mint start) remain supported.
Help Bot calendar fetch timeout code is removed; its help-index and model
settings are unchanged.

Year-round regression coverage includes all twelve months, both DST transitions,
exact opening/closing instants, midnight carry-over, year/season boundaries,
leap day, historical reschedules, and different host timezones. A five-year sweep
checks every regular mint date and Athens phase window from 2026 through 2030.
Skips change the next mint date without extending an existing mint beyond its
next-day close. Internal query calculations retain the asynchronous consumer API
and rejected-error behavior.
Timezone rules come from the runtime's IANA data; keep deployed Node/ICU data
current if governments change timezone law.
