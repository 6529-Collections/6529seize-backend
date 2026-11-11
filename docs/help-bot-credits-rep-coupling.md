# Help6529 Credits and REP: design note

Status: for a product decision. No behaviour changes with this note.

## Current behaviour

Help6529 Credits are stored as REP. The `help6529` profile is the rater and the
reserved REP category `Help6529 Credits` holds each profile's balance
(`src/help-bot/help-bot-credits.service.ts`).

- **Grants and spends move REP totals.** Signup, profile setup, and daily
  activity grants (`HELP_BOT_CREDIT_GRANT`, default 10 each) and the 1-credit
  question charge and its refund all go through `applyBotRatingDelta`. It
  updates the `ratings` row and also adds the same delta to `identities.rep`
  and `identities.level_raw`, and writes a `RATING_EDIT` activity log entry.
- **Everything that reads total REP or Level sees the credits.** That includes
  the displayed REP total and Level (`level_raw`), community member sorting,
  group eligibility filters on REP and Level (`user-groups.service.ts`), and
  wave score formulas that use `level_raw`.
- **Exempt from over-rate checks.** The bot's ratings are excluded from the
  rater-credit over-rate queries in `src/rates/ratings.db.ts`
  (`helpBotCreditOverRateExclusion`), so the bot can hand out any amount
  without its own REP budget being checked or revoked.
- **No accumulation cap.** Balances only go down when a question is charged.
  A profile active every day gains roughly 10 credits (and 10 REP / Level
  points) per day, about 3,650 per year, on top of the one-off grants.
- **Reserved from users.** Users cannot rate in the category; the REP routes
  and category search reject or special-case it
  (`isHelpBotCreditCategory`).

The effect is that an allowance for asking the help bot also raises a
profile's REP and Level over time, and can move it across REP or Level
thresholds used for group eligibility.

## Option A: separate credit ledger

Keep credits out of REP entirely.

- Add a balance table (for example `help_bot_credit_balances`, one row per
  profile) next to the existing `help_bot_credit_events` table, which already
  records every grant and spend idempotently. Charge, refund, and grants
  update the balance row instead of `ratings` and `identities`.
- REP, Level, groups, and the over-rate exclusion no longer need to know about
  the category. The reserved-category checks can stay for a while so the old
  name cannot be reused by users.
- The insufficient-credits reply and help copy change from "Help6529 Credit
  REP" to plain credits; the frontend help index and any UI that shows the
  category need a matching update.

Migration considerations:

1. Backfill balances from the current `ratings` rows for the category (rater =
   bot profile). `help_bot_credit_events` can be used to cross-check.
2. Subtract each profile's category rating from `identities.rep` and
   `identities.level_raw` in batches, then delete or zero the category
   ratings. This lowers REP and Level for every active profile, which can
   change group membership, leaderboards, and wave scores at that moment;
   it needs an announcement and should run when eligibility snapshots are
   not being taken.
3. Ship the code that writes the new ledger before the backfill, with a short
   dual-write window or a maintenance window, so grants and charges are not
   lost between the two steps.
4. Rollback is the reverse batch; keep the pre-migration values.

## Option B: keep REP, cap it and exclude it from totals

Keep the category as the storage, but stop it from inflating totals.

- Cap the balance (for example 50 or 100 credits): grants top up to the cap
  instead of adding unconditionally.
- Stop `applyBotRatingDelta` from touching `identities.rep` and `level_raw`,
  and exclude the category wherever totals are computed from `ratings`
  (aggregations, rebuild jobs, category listings), so a rebuild does not add
  it back.
- Keep the over-rate exclusion, since the bot still rates.

Migration considerations:

1. The same one-off subtraction of existing category ratings from
   `identities.rep` and `level_raw` as in option A (same user-visible drop in
   REP and Level).
2. Trim balances above the cap, or grandfather them and only stop further
   grants above the cap.
3. Audit every reader of REP totals and every job that recomputes them from
   `ratings`; a missed reader brings the credits back into totals. This audit
   surface is the main cost compared with option A.

## Comparison

| Concern                              | Option A (ledger)  | Option B (cap + exclude)     |
| ------------------------------------ | ------------------ | ---------------------------- |
| REP and Level reflect only peer REP  | Yes                | Yes, if every reader filters |
| Ongoing coupling to the ratings code | None               | Category filters everywhere  |
| One-time REP / Level drop for users  | Yes                | Yes                          |
| User-facing wording change           | Yes (no more REP)  | Minimal                      |
| Bounded balance                      | Optional (add cap) | Yes                          |

Either option needs the help index and spec text that describe credits as REP
(`specs/6529-help-bot-runtime.md`, section 2.4) updated in the same release.
