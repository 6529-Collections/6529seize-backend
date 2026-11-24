# Help6529 Credits and REP: record

Status: removed in November 2026. Credits are not REP, and asking help6529 is
free.

## What it was

Help6529 Credits metered questions to the help bot. They were stored as REP:
the `help6529` profile rated users in the `Help6529 Credits` REP category.
Signup, profile setup and daily activity each granted 10 credits by default.
Each question cost 1, refunded when the bot failed before it had an answer.
Every grant, charge and refund also changed the user's `identities.rep` and
`identities.level_raw`. The bot's ratings in that category were exempt from
the over-rate check, and users could not rate in the category.

## Why it was removed

An allowance for asking the help bot raised a profile's REP and Level over
time. An active profile gained about 10 REP and 10 Level points a day, with no
cap. That moved profiles across REP and Level thresholds used by group
eligibility, community sorting and wave scores. A separate credit ledger and a
capped, excluded category were both considered. The decision was to remove
credits entirely.

## How it was removed

1. A default-off flag stopped every grant, charge and refund, and the bot
   answered for free.
2. An operator job deleted the category's REP rows and recomputed REP and
   Level, so both reflect peer REP only.
3. The code was removed: the meter, the grants, the over-rate exemption and
   the reserved category. `Help6529 Credits` is now an ordinary REP category
   name under the normal abusiveness check. Asked about credits, the bot says
   asking is free and it no longer uses Help6529 Credits.

## What remains

- The `help_bot_credit_events` and `help_bot_daily_activity_credit_requests`
  tables, kept as history. Only the worker below still touches the requests
  table.
- `helpBotDailyActivityCreditLoop` and the `help-bot-daily-activity-credits.fifo`
  queue. The worker only completes requests left from before, without a
  grant. Both are to be removed in a later change.
- The `INSUFFICIENT_CREDITS` interaction status, which older rows may hold.
