# Subscription status at the mint-day cutoff

Subscription changes close at 00:00 UTC on Monday, Wednesday, and Friday,
including when that day's Meme has not been released yet. The API uses the
same card boundary for automatic-mode updates, direct card subscription and
quantity updates, and subscription-status reads.

After that boundary, the profile Upcoming Drops API and the homepage's
per-card upcoming-status API use the saved card subscription. A missing card
record is unsubscribed; current Automatic mode must not supply a subscription
for a closed card. Existing card opt-ins and opt-outs remain authoritative.
Enabling Automatic mode, including through the first top-up, applies to later
cards. Turning it off also leaves the closed card's saved choice unchanged.

Closed-card aggregate subscription counts use the finalized subscription list,
so a later top-up or mode change does not change the displayed mint-day count.
Future-card counts continue to use current preferences and available balance.

This status handling does not change the daily list-generation job or rebuild
finalized subscription lists. Subscription selection and allocation remain
separate: a selected card can have no assigned phase. The frontend displays
`No subscription allocation` only for a subscribed first upcoming card after
normalized distribution is published and successful lookups establish that no
subscription phase is assigned. An API failure is not evidence of no allocation.

Response shapes are unchanged. The frontend help corpus documents these states.
Deploy `api` and `subscriptionsTopUpLoop` (which bundles the shared mode updater)
before the companion frontend change. No entity synchronization or migration is
required.
